// MIT License
// Copyright (c) 2026 sparetimecoders

import type { TextMapPropagator } from "@opentelemetry/api";
import type {
  Topology,
  Endpoint,
  EventHandler,
  RequestResponseEventHandler,
  NotificationHandler,
  ErrorNotificationHandler,
  MetricsRecorder,
  RoutingKeyMapper,
} from "@gomessaging/spec";
import {
  DefaultEventExchangeName,
  natsStreamName,
} from "@gomessaging/spec";
import {
  connect,
  Events,
  type ConnectionOptions as NatsConnectionOptions,
  type NatsConnection,
  type JetStreamClient,
} from "nats";
import { Publisher } from "./publisher.js";
import type {
  JSConsumerRegistration,
  CoreConsumerRegistration,
  ConsumerHandle,
} from "./consumer.js";
import {
  startJSConsumers,
  startCoreConsumers,
} from "./consumer.js";

/** Retention limits for a JetStream stream. */
export interface StreamConfig {
  /** Maximum age of messages in nanoseconds. Zero means unlimited (NATS default). */
  maxAge?: number;
  /** Maximum total size of messages in bytes. Zero means unlimited. */
  maxBytes?: number;
  /** Maximum number of messages. Zero means unlimited. */
  maxMsgs?: number;
}

/** Sensible stream defaults matching the Go implementation: 7d age, 1GB bytes, 1M messages. */
export const DefaultStreamConfig: Readonly<Required<StreamConfig>> = {
  maxAge: 7 * 24 * 60 * 60 * 1e9, // 7 days in nanoseconds
  maxBytes: 1_073_741_824, // 1 GiB
  maxMsgs: 1_000_000, // 1 million
} as const;

/** Default JetStream consumer behavior applied to all consumers. */
export interface ConsumerDefaults {
  /**
   * Maximum number of delivery attempts.
   * Zero or undefined means unlimited (NATS default).
   */
  maxDeliver?: number;

  /**
   * Redelivery backoff durations in milliseconds.
   * The server waits backOff[min(attempt, len-1)] before redelivering.
   */
  backOff?: number[];
}

/** Per-consumer options that override connection-level defaults. */
export interface ConsumerOptions {
  /**
   * Maximum number of delivery attempts for this consumer.
   * Overrides the connection-level consumerDefaults.maxDeliver.
   */
  maxDeliver?: number;

  /**
   * Redelivery backoff durations in milliseconds for this consumer.
   * Overrides the connection-level consumerDefaults.backOff.
   */
  backOff?: number[];
}

export interface ConnectionOptions {
  /** NATS connection URL (e.g., "nats://localhost:4222") */
  url: string;
  /** Service name for subscription/queue naming */
  serviceName: string;
  /** Optional logger (defaults to console) */
  logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
  /** Optional OTel propagator for trace context propagation */
  propagator?: TextMapPropagator;
  /** Timeout in milliseconds for NATS Core request-reply operations. Default: 30000 (30s). */
  requestTimeout?: number;
  /** Default retention limits applied to all streams. Use DefaultStreamConfig for sensible defaults. */
  streamDefaults?: StreamConfig;
  /** Per-stream retention limit overrides keyed by stream name. Overrides streamDefaults entirely (no merging). */
  streamConfigs?: Record<string, StreamConfig>;
  /** Default MaxDeliver and BackOff applied to all JetStream consumers. Per-consumer options take precedence. */
  consumerDefaults?: ConsumerDefaults;
  /** Callback invoked after a consumer handler completes successfully. */
  onNotification?: NotificationHandler;
  /** Callback invoked after a consumer handler fails with an error. */
  onError?: ErrorNotificationHandler;
  /** Optional metrics recorder for instrumentation. */
  metrics?: MetricsRecorder;
  /** Optional routing key mapper applied before passing keys to metrics. */
  routingKeyMapper?: RoutingKeyMapper;
  /**
   * Pass-through options for the underlying NATS client connection.
   * Allows configuring reconnection behavior (maxReconnectAttempts,
   * reconnectTimeWait, reconnectJitter, etc.) and other NATS client settings.
   * The `servers` field is ignored here; use the top-level `url` instead.
   */
  natsOptions?: Partial<Omit<NatsConnectionOptions, "servers">>;
  /** Callback invoked when the client reconnects to the NATS server. */
  onReconnect?: () => void;
  /** Callback invoked when the client disconnects from the NATS server. */
  onDisconnect?: (error: Error) => void;
}

/** NATS client stream config fields (snake_case, matching jsapi_types). */
interface StreamConfigNats {
  max_age?: number;
  max_bytes?: number;
  max_msgs?: number;
}

/** Callback that resolves NATS stream config for a given stream name. */
export type StreamConfigResolver = (stream: string) => StreamConfigNats;

/**
 * Connection manages a NATS connection and provides methods to
 * set up event streams (via JetStream), custom streams, and
 * request-response patterns (via Core NATS).
 */
export class Connection {
  private readonly url: string;
  private readonly serviceName: string;
  private readonly logger: Pick<Console, "info" | "warn" | "error" | "debug">;
  private readonly propagator?: TextMapPropagator;
  private readonly endpoints: Endpoint[] = [];
  private readonly requestTimeout: number;
  private readonly streamDefaults: StreamConfig;
  private readonly streamConfigs: ReadonlyMap<string, StreamConfig>;
  private readonly consumerDefaults: ConsumerDefaults;
  private readonly onNotification?: NotificationHandler;
  private readonly onError?: ErrorNotificationHandler;
  private readonly metrics?: MetricsRecorder;
  private readonly routingKeyMapper?: RoutingKeyMapper;
  private readonly natsOptions: Partial<Omit<NatsConnectionOptions, "servers">>;
  private readonly onReconnect?: () => void;
  private readonly onDisconnect?: (error: Error) => void;

  private nc: NatsConnection | null = null;
  private statusMonitorAbort: AbortController | null = null;
  private js: JetStreamClient | null = null;

  private readonly jsRegistrations: JSConsumerRegistration<unknown>[] = [];
  private readonly coreRegistrations: CoreConsumerRegistration<unknown, unknown>[] = [];
  private readonly publishers: Publisher[] = [];
  private readonly consumerHandles: ConsumerHandle[] = [];

  // Track streams that need publishers wired
  private readonly jsPublisherStreams: { stream: string; publisher: Publisher }[] = [];
  private readonly corePublisherTargets: { targetService: string; publisher: Publisher }[] = [];

  constructor(options: ConnectionOptions) {
    this.url = options.url;
    this.serviceName = options.serviceName;
    this.logger = options.logger ?? console;
    this.propagator = options.propagator;
    this.requestTimeout = options.requestTimeout ?? 30_000;
    this.streamDefaults = options.streamDefaults ?? {};
    const configs = new Map<string, StreamConfig>();
    if (options.streamConfigs) {
      for (const [name, cfg] of Object.entries(options.streamConfigs)) {
        const resolved = natsStreamName(name);
        configs.set(resolved, cfg);
      }
    }
    this.streamConfigs = configs;
    this.consumerDefaults = options.consumerDefaults ?? {};
    this.onNotification = options.onNotification;
    this.onError = options.onError;
    this.metrics = options.metrics;
    this.routingKeyMapper = options.routingKeyMapper;
    this.natsOptions = options.natsOptions ?? {};
    this.onReconnect = options.onReconnect;
    this.onDisconnect = options.onDisconnect;
  }

  /**
   * Register an event stream publisher on the default "events" stream.
   * Returns a Publisher that can be used to publish after start().
   */
  addEventPublisher(): Publisher {
    const stream = natsStreamName(DefaultEventExchangeName);
    const publisher = new Publisher({
      serviceName: this.serviceName,
      stream,
      propagator: this.propagator,
      metrics: this.metrics,
      routingKeyMapper: this.routingKeyMapper,
    });
    this.publishers.push(publisher);
    this.jsPublisherStreams.push({ stream, publisher });
    this.endpoints.push({
      direction: "publish",
      pattern: "event-stream",
      exchangeName: stream,
      exchangeKind: "topic",
    });
    return publisher;
  }

  /**
   * Register an event stream consumer (JetStream durable consumer).
   */
  addEventConsumer<T>(
    routingKey: string,
    handler: EventHandler<T>,
    options?: { ephemeral?: boolean; queueSuffix?: string } & ConsumerOptions,
  ): void {
    const stream = natsStreamName(DefaultEventExchangeName);
    const baseDurable = options?.ephemeral ? undefined : this.serviceName;
    const durable = baseDurable && options?.queueSuffix
      ? `${baseDurable}-${options.queueSuffix}`
      : baseDurable;
    this.jsRegistrations.push({
      kind: "jetstream",
      stream,
      routingKey,
      handler: handler as EventHandler<unknown>,
      durable,
      maxDeliver: options?.maxDeliver,
      backOff: options?.backOff,
    });
    this.endpoints.push({
      direction: "consume",
      pattern: "event-stream",
      exchangeName: stream,
      exchangeKind: "topic",
      queueName: options?.ephemeral ? undefined : durable,
      routingKey,
      ephemeral: options?.ephemeral,
    });
  }

  /**
   * Register a custom stream publisher.
   * Returns a Publisher that can be used to publish after start().
   */
  addCustomStreamPublisher(exchange: string): Publisher {
    const stream = natsStreamName(exchange);
    const publisher = new Publisher({
      serviceName: this.serviceName,
      stream,
      propagator: this.propagator,
      metrics: this.metrics,
      routingKeyMapper: this.routingKeyMapper,
    });
    this.publishers.push(publisher);
    this.jsPublisherStreams.push({ stream, publisher });
    this.endpoints.push({
      direction: "publish",
      pattern: "custom-stream",
      exchangeName: stream,
      exchangeKind: "topic",
    });
    return publisher;
  }

  /**
   * Register a custom stream consumer.
   */
  addCustomStreamConsumer<T>(
    exchange: string,
    routingKey: string,
    handler: EventHandler<T>,
    options?: { ephemeral?: boolean; queueSuffix?: string } & ConsumerOptions,
  ): void {
    const stream = natsStreamName(exchange);
    const baseDurable = options?.ephemeral ? undefined : this.serviceName;
    const durable = baseDurable && options?.queueSuffix
      ? `${baseDurable}-${options.queueSuffix}`
      : baseDurable;
    this.jsRegistrations.push({
      kind: "jetstream",
      stream,
      routingKey,
      handler: handler as EventHandler<unknown>,
      durable,
      maxDeliver: options?.maxDeliver,
      backOff: options?.backOff,
    });
    this.endpoints.push({
      direction: "consume",
      pattern: "custom-stream",
      exchangeName: stream,
      exchangeKind: "topic",
      queueName: durable,
      routingKey,
      ephemeral: options?.ephemeral,
    });
  }

  /**
   * Register a service request consumer (Core NATS request-reply).
   */
  addServiceRequestConsumer<T, R>(
    routingKey: string,
    handler: RequestResponseEventHandler<T, R>,
  ): void {
    const subject = `${this.serviceName}.request.${routingKey}`;
    this.coreRegistrations.push({
      kind: "core",
      subject,
      routingKey,
      handler: handler as RequestResponseEventHandler<unknown, unknown>,
      requestReply: true,
    });
    this.endpoints.push({
      direction: "consume",
      pattern: "service-request",
      exchangeName: this.serviceName,
      exchangeKind: "direct",
      queueName: this.serviceName,
      routingKey,
    });
  }

  /**
   * Register a service request publisher.
   * Returns a Publisher that can be used to publish after start().
   */
  addServiceRequestPublisher(targetService: string): Publisher {
    const publisher = new Publisher({
      serviceName: this.serviceName,
      stream: targetService,
      propagator: this.propagator,
      metrics: this.metrics,
      routingKeyMapper: this.routingKeyMapper,
      subjectFn: (service, routingKey) => `${service}.request.${routingKey}`,
    });
    this.publishers.push(publisher);
    this.corePublisherTargets.push({ targetService, publisher });
    this.endpoints.push({
      direction: "publish",
      pattern: "service-request",
      exchangeName: targetService,
      exchangeKind: "direct",
    });
    return publisher;
  }

  /**
   * Register a service response consumer.
   * In NATS, request-reply responses are handled automatically by the
   * request() call. This method exists for topology registration.
   */
  addServiceResponseConsumer<T>(
    targetService: string,
    routingKey: string,
    _handler: EventHandler<T>,
  ): void {
    this.endpoints.push({
      direction: "consume",
      pattern: "service-response",
      exchangeName: targetService,
      exchangeKind: "headers",
      queueName: this.serviceName,
      routingKey,
    });
  }

  /**
   * Returns the declared topology for this service.
   */
  topology(): Topology {
    return {
      transport: "nats",
      serviceName: this.serviceName,
      endpoints: [...this.endpoints],
    };
  }

  /**
   * Resolve the StreamConfig for a given stream name.
   * Per-stream overrides replace defaults entirely (no field-level merging).
   */
  private resolveStreamConfig(stream: string): StreamConfigNats {
    const sc = this.streamConfigs.get(stream) ?? this.streamDefaults;
    const result: StreamConfigNats = {};
    if (sc.maxAge !== undefined && sc.maxAge > 0) {
      result.max_age = sc.maxAge;
    }
    if (sc.maxBytes !== undefined && sc.maxBytes > 0) {
      result.max_bytes = sc.maxBytes;
    }
    if (sc.maxMsgs !== undefined && sc.maxMsgs > 0) {
      result.max_msgs = sc.maxMsgs;
    }
    if (sc.maxAge === undefined && sc.maxBytes === undefined && sc.maxMsgs === undefined) {
      this.logger.warn(
        `[gomessaging/nats] Stream "${stream}" has no retention limits configured, storage may grow unbounded`,
      );
    }
    return result;
  }

  /**
   * Start the NATS connection and set up streams/subscriptions.
   */
  async start(): Promise<void> {
    this.logger.info(
      `[gomessaging/nats] Starting connection to ${this.url} for service "${this.serviceName}"`,
    );

    // Connect to NATS, merging user-provided natsOptions
    this.nc = await connect({ ...this.natsOptions, servers: [this.url] });
    this.js = this.nc.jetstream();

    // Wire reconnection event callbacks via NATS status iterator
    if (this.onReconnect ?? this.onDisconnect) {
      this.monitorStatus(this.nc);
    }
    const jsm = await this.nc.jetstreamManager();

    this.logger.info(`[gomessaging/nats] Connected to ${this.url}`);

    // Ensure streams for publishers and wire them
    for (const { stream, publisher } of this.jsPublisherStreams) {
      const streamCfg = this.resolveStreamConfig(stream);
      try {
        await jsm.streams.add({
          name: stream,
          subjects: [`${stream}.>`],
          ...streamCfg,
        });
      } catch {
        // Stream may already exist
        try {
          await jsm.streams.update(stream, {
            subjects: [`${stream}.>`],
            ...streamCfg,
          });
        } catch {
          // Already exists with correct config
        }
      }
      publisher.wireJetStream(this.js);
    }

    // Wire Core request publishers
    for (const { publisher } of this.corePublisherTargets) {
      publisher.wireCoreRequest(this.nc, this.requestTimeout);
    }

    // Start JetStream consumers
    if (this.jsRegistrations.length > 0) {
      const handles = await startJSConsumers(
        this.js,
        jsm,
        this.serviceName,
        this.jsRegistrations,
        this.logger,
        this.propagator,
        (stream) => this.resolveStreamConfig(stream),
        this.consumerDefaults,
        this.onNotification,
        this.onError,
        this.metrics,
        this.routingKeyMapper,
      );
      this.consumerHandles.push(...handles);
    }

    // Start Core consumers
    if (this.coreRegistrations.length > 0) {
      const handles = startCoreConsumers(
        this.nc,
        this.serviceName,
        this.coreRegistrations,
        this.logger,
        this.propagator,
        this.onNotification,
        this.onError,
        this.metrics,
        this.routingKeyMapper,
      );
      this.consumerHandles.push(...handles);
    }

    // Flush to ensure all subscriptions are propagated to the server
    // before returning. Without this, request-reply patterns can fail
    // with 503 (no responders) if the requester fires before the
    // subscriber's registration reaches the server.
    await this.nc.flush();

    this.logger.info(
      `[gomessaging/nats] Connection started for service "${this.serviceName}"`,
    );
  }

  /**
   * Gracefully close the connection.
   */
  async close(): Promise<void> {
    this.logger.info(
      `[gomessaging/nats] Closing connection for service "${this.serviceName}"`,
    );

    // Stop status monitor
    this.statusMonitorAbort?.abort();
    this.statusMonitorAbort = null;

    // Stop all consumer handles
    for (const handle of this.consumerHandles) {
      handle.stop();
    }

    // Drain and close (drain processes in-flight messages before closing)
    if (this.nc) {
      try {
        await this.nc.drain();
      } catch {
        // Connection may already be closed; ignore drain errors
      }
      this.nc = null;
      this.js = null;
    }
  }

  /**
   * Monitor NATS connection status events and invoke user callbacks.
   * Runs in the background until the AbortController is signalled.
   */
  private monitorStatus(nc: NatsConnection): void {
    const abort = new AbortController();
    this.statusMonitorAbort = abort;

    void (async () => {
      for await (const status of nc.status()) {
        if (abort.signal.aborted) break;
        if (status.type === Events.Reconnect) {
          this.onReconnect?.();
        } else if (status.type === Events.Disconnect) {
          const data = typeof status.data === "string" ? status.data : "disconnected";
          this.onDisconnect?.(new Error(data));
        }
      }
    })();
  }
}
