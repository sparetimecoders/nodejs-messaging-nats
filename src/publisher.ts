// MIT License
// Copyright (c) 2026 sparetimecoders

import { randomUUID } from "node:crypto";
import type { Context } from "@opentelemetry/api";
import type { JetStreamClient, NatsConnection, MsgHdrs } from "nats";
import { headers as natsHeaders } from "nats";
import type { MetricsRecorder, RoutingKeyMapper } from "@gomessaging/spec";
import {
  CESpecVersion,
  CESpecVersionValue,
  CEType,
  CESource,
  CEDataContentType,
  CETime,
  CEID,
  natsSubject,
  mapRoutingKey,
} from "@gomessaging/spec";
import { injectToHeaders } from "./tracing.js";
import type { TextMapPropagator } from "@opentelemetry/api";

const contentType = "application/json";

type PublishFn = (subject: string, data: Uint8Array, headers: MsgHdrs) => Promise<void>;

export interface PublisherOptions {
  serviceName: string;
  stream: string;
  propagator?: TextMapPropagator;
  metrics?: MetricsRecorder;
  routingKeyMapper?: RoutingKeyMapper;
  /** Custom subject builder. Defaults to natsSubject(stream, routingKey). */
  subjectFn?: (stream: string, routingKey: string) => string;
}

/**
 * Publisher sends messages to NATS via JetStream or Core request-reply.
 */
export class Publisher {
  private readonly serviceName: string;
  private readonly stream: string;
  private readonly propagator?: TextMapPropagator;
  private readonly metrics?: MetricsRecorder;
  private readonly routingKeyMapper?: RoutingKeyMapper;
  private readonly subjectFn: (stream: string, routingKey: string) => string;
  private publishFn: PublishFn | null = null;

  constructor(options: PublisherOptions) {
    this.serviceName = options.serviceName;
    this.stream = options.stream;
    this.propagator = options.propagator;
    this.metrics = options.metrics;
    this.routingKeyMapper = options.routingKeyMapper;
    this.subjectFn = options.subjectFn ?? natsSubject;
  }

  /** Wire this publisher to use JetStream publish. */
  wireJetStream(js: JetStreamClient): void {
    this.publishFn = async (subject, data, hdrs) => {
      await js.publish(subject, data, { headers: hdrs });
    };
  }

  /** Wire this publisher to use Core NATS request-reply. */
  wireCoreRequest(nc: NatsConnection, timeout: number = 30_000): void {
    this.publishFn = async (subject, data, hdrs) => {
      await nc.request(subject, data, { timeout, headers: hdrs });
    };
  }

  /**
   * Publish a message with the given routing key.
   * CloudEvents headers are set using the setDefault pattern.
   *
   * @param routingKey - The routing key for the message.
   * @param msg - The message payload (will be JSON-serialized).
   * @param ctxOrHeaders - Optional OTel context for trace propagation,
   *   or a Record of custom headers to set on the message.
   * @param customHeaders - Optional custom headers when ctxOrHeaders is a Context.
   */
  async publish(
    routingKey: string,
    msg: unknown,
    ctxOrHeaders?: Context | Record<string, string>,
    customHeaders?: Record<string, string>,
  ): Promise<void> {
    if (!this.publishFn) {
      throw new Error("Publisher not wired — call wireJetStream or wireCoreRequest first");
    }

    // Resolve overloaded parameters
    let ctx: Context | undefined;
    let extraHeaders: Record<string, string> | undefined;
    if (ctxOrHeaders !== undefined && typeof ctxOrHeaders === "object" && !("getValue" in ctxOrHeaders)) {
      extraHeaders = ctxOrHeaders as Record<string, string>;
    } else {
      ctx = ctxOrHeaders as Context | undefined;
      extraHeaders = customHeaders;
    }

    const subject = this.subjectFn(this.stream, routingKey);
    const data = new TextEncoder().encode(JSON.stringify(msg));

    const hdrs = natsHeaders();

    // Apply custom headers first so CE defaults don't override them
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        hdrs.set(k, v);
      }
    }

    // Set service header
    hdrs.set("service", this.serviceName);

    // setDefault pattern: only set if not already present
    const setDefault = (key: string, value: string) => {
      if (!hdrs.has(key)) {
        hdrs.set(key, value);
      }
    };

    setDefault(CESpecVersion, CESpecVersionValue);
    setDefault(CEType, routingKey);
    setDefault(CESource, this.serviceName);
    setDefault(CEDataContentType, contentType);
    setDefault(CETime, new Date().toISOString());

    const messageID = hdrs.has(CEID) ? hdrs.get(CEID) : randomUUID();
    hdrs.set(CEID, messageID);

    // Inject trace context if available
    if (ctx) {
      injectToHeaders(ctx, hdrs, this.propagator);
    }

    const mappedKey = mapRoutingKey(routingKey, this.routingKeyMapper);
    const startTime = Date.now();

    try {
      await this.publishFn(subject, data, hdrs);
      this.metrics?.publishSucceed(this.stream, mappedKey, Date.now() - startTime);
    } catch (err) {
      this.metrics?.publishFailed(this.stream, mappedKey, Date.now() - startTime);
      throw err;
    }
  }
}
