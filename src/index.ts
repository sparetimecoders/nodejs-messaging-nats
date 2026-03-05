// MIT License
// Copyright (c) 2026 sparetimecoders

/**
 * @gomessaging/nats - NATS transport for gomessaging
 *
 * This module provides a NATS transport implementation (JetStream + Core)
 * that follows the gomessaging specification for naming conventions,
 * topology, and CloudEvents binary content mode.
 *
 * Usage:
 *   import { Connection } from "@gomessaging/nats";
 *
 *   const conn = new Connection({ url: "nats://localhost:4222", serviceName: "my-service" });
 *   const publisher = conn.addEventPublisher();
 *   await conn.start();
 *   await publisher.publish("order.created", { orderId: "123" });
 */

export { Connection, DefaultStreamConfig } from "./connection.js";
export type { ConnectionOptions, StreamConfig, StreamConfigResolver, ConsumerDefaults, ConsumerOptions } from "./connection.js";
export { Publisher } from "./publisher.js";
export type { PublisherOptions } from "./publisher.js";
export { injectToHeaders, extractToContext } from "./tracing.js";
