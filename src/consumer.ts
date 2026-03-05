// MIT License
// Copyright (c) 2026 sparetimecoders

import type { JetStreamClient, NatsConnection, JetStreamManager, ConsumerMessages } from "nats";
import { AckPolicy } from "nats";
import type {
  ConsumableEvent,
  EventHandler,
  Headers,
  RequestResponseEventHandler,
  NotificationHandler,
  ErrorNotificationHandler,
  MetricsRecorder,
  RoutingKeyMapper,
} from "@gomessaging/spec";
import {
  metadataFromHeaders,
  validateCEHeaders,
  ErrParseJSON,
  natsSubject,
  translateWildcard,
  matchRoutingKey,
  mapRoutingKey,
} from "@gomessaging/spec";
import { extractToContext } from "./tracing.js";
import type { TextMapPropagator } from "@opentelemetry/api";
import type { StreamConfigResolver, ConsumerDefaults } from "./connection.js";

type Logger = Pick<Console, "info" | "warn" | "error" | "debug">;

/** Internal registration for a JetStream consumer. */
export interface JSConsumerRegistration<T> {
  kind: "jetstream";
  stream: string;
  routingKey: string;
  handler: EventHandler<T>;
  durable?: string;
  /** Per-consumer max delivery attempts. Overrides connection-level consumerDefaults. */
  maxDeliver?: number;
  /** Per-consumer backoff durations in ms. Overrides connection-level consumerDefaults. */
  backOff?: number[];
}

/** Internal registration for a Core NATS consumer. */
export interface CoreConsumerRegistration<T, R = void> {
  kind: "core";
  subject: string;
  routingKey: string;
  handler: EventHandler<T> | RequestResponseEventHandler<T, R>;
  requestReply: boolean;
}

export type ConsumerRegistration =
  | JSConsumerRegistration<unknown>
  | CoreConsumerRegistration<unknown, unknown>;

/** Active handles for cleanup. */
export interface ConsumerHandle {
  stop(): void;
}

/** Convert NATS MsgHdrs to spec Headers (Record<string, unknown>). */
function fromNATSHeaders(hdrs: { keys(): string[]; get(k: string): string } | undefined): Headers {
  const h: Headers = {};
  if (!hdrs) return h;
  for (const k of hdrs.keys()) {
    h[k] = hdrs.get(k);
  }
  return h;
}

/** Key for grouping registrations that share a NATS JetStream consumer. */
function consumerGroupKey(reg: JSConsumerRegistration<unknown>): string {
  return `${reg.stream}:${reg.durable ?? ""}`;
}

/**
 * Start all registered JetStream consumers.
 *
 * Registrations sharing the same stream+durable are grouped into a single
 * NATS consumer with multiple filter_subjects (matching AMQP's one-queue,
 * many-bindings model). Messages are dispatched to the correct handler
 * based on routing key.
 *
 * Returns handles for cleanup.
 */
export async function startJSConsumers(
  js: JetStreamClient,
  jsm: JetStreamManager,
  serviceName: string,
  registrations: JSConsumerRegistration<unknown>[],
  logger: Logger,
  propagator?: TextMapPropagator,
  resolveStreamConfig?: StreamConfigResolver,
  consumerDefaults?: ConsumerDefaults,
  onNotification?: NotificationHandler,
  onError?: ErrorNotificationHandler,
  metrics?: MetricsRecorder,
  routingKeyMapper?: RoutingKeyMapper,
): Promise<ConsumerHandle[]> {
  const handles: ConsumerHandle[] = [];

  // Group registrations by stream+durable so we create one NATS consumer per group.
  const groups = new Map<string, JSConsumerRegistration<unknown>[]>();
  for (const reg of registrations) {
    const key = consumerGroupKey(reg);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(reg);
  }

  for (const group of groups.values()) {
    const first = group[0];
    const stream = first.stream;
    const durable = first.durable;

    // Ensure stream exists
    const streamSubjects = `${stream}.>`;
    const streamCfg = resolveStreamConfig ? resolveStreamConfig(stream) : {};
    try {
      await jsm.streams.add({
        name: stream,
        subjects: [streamSubjects],
        ...streamCfg,
      });
    } catch {
      try {
        await jsm.streams.update(stream, {
          subjects: [streamSubjects],
          ...streamCfg,
        });
      } catch {
        // Already exists with correct config
      }
    }

    // Build handler map and filter subjects for all registrations in this group
    const handlerMap = new Map<string, EventHandler<unknown>>();
    const filterSubjects: string[] = [];
    for (const reg of group) {
      const filter = natsSubject(stream, translateWildcard(reg.routingKey));
      filterSubjects.push(filter);
      handlerMap.set(reg.routingKey, reg.handler);
    }

    // Create or update the consumer with all filter subjects
    const consumerCfg: Partial<import("nats").ConsumerConfig> = {
      ack_policy: AckPolicy.Explicit,
    };
    if (durable) {
      consumerCfg.durable_name = durable;
    }
    if (filterSubjects.length === 1) {
      consumerCfg.filter_subject = filterSubjects[0];
    } else {
      consumerCfg.filter_subjects = filterSubjects;
    }

    // Apply MaxDeliver: per-consumer override > connection default.
    const maxDeliver = first.maxDeliver ?? consumerDefaults?.maxDeliver;
    if (maxDeliver !== undefined && maxDeliver > 0) {
      consumerCfg.max_deliver = maxDeliver;
    }

    // Apply BackOff: per-consumer override > connection default.
    const backOff = first.backOff ?? consumerDefaults?.backOff;
    if (backOff !== undefined && backOff.length > 0) {
      // NATS server expects nanoseconds; convert from milliseconds.
      consumerCfg.backoff = backOff.map((ms) => ms * 1_000_000);
    }

    let consumerName = durable;
    try {
      const ci = await jsm.consumers.add(stream, consumerCfg);
      consumerName = ci.name;
    } catch {
      // Consumer exists with incompatible config — delete and recreate
      if (durable) {
        await jsm.consumers.delete(stream, durable);
        const ci = await jsm.consumers.add(stream, consumerCfg);
        consumerName = ci.name;
      }
    }

    const consumer = await js.consumers.get(stream, consumerName);
    const messages: ConsumerMessages = await consumer.consume();

    handles.push({ stop() { messages.stop(); } });

    // Process messages in background, dispatching by routing key
    (async () => {
      for await (const msg of messages) {
        const subject = msg.subject;
        // Extract routing key: strip stream prefix
        let routingKey = subject;
        const dotIdx = subject.indexOf(".");
        if (dotIdx >= 0) {
          routingKey = subject.substring(dotIdx + 1);
        }

        const consumerName = durable ?? serviceName;
        const mappedKey = mapRoutingKey(routingKey, routingKeyMapper);

        metrics?.eventReceived(consumerName, mappedKey);

        let handler: EventHandler<unknown> | undefined;
        for (const [pattern, h] of handlerMap) {
          if (matchRoutingKey(pattern, routingKey)) {
            handler = h;
            break;
          }
        }
        if (!handler) {
          logger.warn(`[gomessaging/nats] No handler for routingKey=${routingKey} on stream=${stream}`);
          metrics?.eventWithoutHandler(consumerName, mappedKey);
          msg.nak();
          continue;
        }

        const headers = fromNATSHeaders(msg.headers);

        const warnings = validateCEHeaders(headers);
        if (warnings.length > 0) {
          logger.warn(
            `[gomessaging/nats] Invalid CE headers on ${subject}: ${warnings.join(", ")}`,
          );
        }

        const metadata = metadataFromHeaders(headers);
        const deliveryInfo = {
          destination: consumerName,
          source: stream,
          key: routingKey,
          headers,
        };

        // Extract trace context
        extractToContext(msg.headers!, propagator);

        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(msg.data));
        } catch {
          logger.error(`[gomessaging/nats] Failed to parse message on ${subject}`);
          metrics?.eventNotParsable(consumerName, mappedKey);
          msg.term();
          continue;
        }

        const event: ConsumableEvent<unknown> = {
          ...metadata,
          deliveryInfo,
          payload,
        };

        const startTime = Date.now();
        try {
          await handler(event);
          const durationMs = Date.now() - startTime;
          metrics?.eventAck(consumerName, mappedKey, durationMs);
          onNotification?.({
            deliveryInfo,
            durationMs,
            source: "CONSUMER",
          });
          msg.ack();
        } catch (err) {
          const durationMs = Date.now() - startTime;
          metrics?.eventNack(consumerName, mappedKey, durationMs);
          const errObj = err instanceof Error ? err : new Error(String(err));
          onError?.({
            deliveryInfo,
            durationMs,
            source: "CONSUMER",
            error: errObj,
          });
          const errMsg = errObj.message;
          if (errMsg.includes(ErrParseJSON)) {
            logger.warn(`[gomessaging/nats] Parse error, terminating: ${errMsg}`);
            msg.term();
          } else {
            logger.error(`[gomessaging/nats] Handler failed, naking: ${errMsg}`);
            msg.nak();
          }
        }
      }
    })();

    const routingKeys = group.map(r => r.routingKey).join(", ");
    logger.info(
      `[gomessaging/nats] Started JetStream consumer stream=${stream} routingKeys=[${routingKeys}]`,
    );
  }

  return handles;
}

/**
 * Start all registered Core NATS consumers.
 * Returns subscription handles for cleanup.
 */
export function startCoreConsumers(
  nc: NatsConnection,
  serviceName: string,
  registrations: CoreConsumerRegistration<unknown, unknown>[],
  logger: Logger,
  propagator?: TextMapPropagator,
  onNotification?: NotificationHandler,
  onError?: ErrorNotificationHandler,
  metrics?: MetricsRecorder,
  routingKeyMapper?: RoutingKeyMapper,
): ConsumerHandle[] {
  const handles: ConsumerHandle[] = [];

  for (const reg of registrations) {
    const sub = nc.subscribe(reg.subject, {
      callback: async (_err, msg) => {
        if (_err) {
          logger.error(`[gomessaging/nats] Subscription error on ${reg.subject}: ${_err.message}`);
          return;
        }

        const mappedKey = mapRoutingKey(reg.routingKey, routingKeyMapper);
        metrics?.eventReceived(serviceName, mappedKey);

        const headers = fromNATSHeaders(msg.headers);
        const deliveryInfo = {
          destination: serviceName,
          source: msg.subject,
          key: reg.routingKey,
          headers,
        };

        // Extract trace context
        if (msg.headers) {
          extractToContext(msg.headers, propagator);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(msg.data));
        } catch {
          logger.error(`[gomessaging/nats] Failed to parse message on ${reg.subject}`);
          metrics?.eventNotParsable(serviceName, mappedKey);
          return;
        }

        const metadata = metadataFromHeaders(headers);
        const event: ConsumableEvent<unknown> = {
          ...metadata,
          deliveryInfo,
          payload,
        };

        const startTime = Date.now();
        try {
          if (reg.requestReply) {
            const respHandler = reg.handler as RequestResponseEventHandler<unknown, unknown>;
            const result = await respHandler(event);
            const respData = new TextEncoder().encode(JSON.stringify(result));
            msg.respond(respData);
          } else {
            await (reg.handler as EventHandler<unknown>)(event);
          }
          const durationMs = Date.now() - startTime;
          metrics?.eventAck(serviceName, mappedKey, durationMs);
          onNotification?.({
            deliveryInfo,
            durationMs,
            source: "CONSUMER",
          });
        } catch (err) {
          const durationMs = Date.now() - startTime;
          metrics?.eventNack(serviceName, mappedKey, durationMs);
          const errObj = err instanceof Error ? err : new Error(String(err));
          onError?.({
            deliveryInfo,
            durationMs,
            source: "CONSUMER",
            error: errObj,
          });
          logger.error(`[gomessaging/nats] Handler failed on ${reg.subject}: ${errObj.message}`);
          if (reg.requestReply && msg.reply) {
            const errResp = new TextEncoder().encode(JSON.stringify({ error: errObj.message }));
            msg.respond(errResp);
          }
        }
      },
    });

    handles.push({
      stop() {
        sub.unsubscribe();
      },
    });

    logger.info(
      `[gomessaging/nats] Started Core consumer subject=${reg.subject} routingKey=${reg.routingKey}`,
    );
  }

  return handles;
}
