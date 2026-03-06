# @sparetimecoders/messaging-nats

<p align="center">
  <strong>NATS/JetStream transport for gomessaging (Node.js/TypeScript).</strong>
</p>

<p align="center">
  <a href="https://github.com/sparetimecoders/nodejs-messaging-nats/actions"><img alt="CI" src="https://github.com/sparetimecoders/nodejs-messaging-nats/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@sparetimecoders/messaging-nats"><img alt="npm" src="https://img.shields.io/npm/v/@sparetimecoders/messaging-nats"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

---

NATS transport implementation for the [gomessaging](https://github.com/sparetimecoders/messaging) specification. Uses **JetStream** for durable event and custom streams, and **Core NATS** for request-reply patterns. All messages carry CloudEvents 1.0 metadata, and naming conventions are deterministic per the shared spec.

> **Deep dives**: See the [docs/](docs/) directory for detailed guides on [connection & configuration](docs/connection.md), [consumers](docs/consumers.md), [publishers](docs/publishers.md), [request-response](docs/request-response.md), [streams & retention](docs/streams.md), and [observability](docs/observability.md).

## Installation

```bash
npm install @sparetimecoders/messaging-nats
```

## Quick Start

```typescript
import { Connection } from "@sparetimecoders/messaging-nats";

const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
});

const pub = conn.addEventPublisher();

conn.addEventConsumer("Order.Created", async (event) => {
  console.log(`Order ${event.payload.orderId} from ${event.source}`);
});

await conn.start();

await pub.publish("Order.Created", { orderId: "abc-123", amount: 42 });
```

## Messaging Patterns

### Event Stream

Publish domain events to the default `events` JetStream stream. Any number of services can subscribe by routing key. Consumers are durable by default (survive restarts); pass `ephemeral: true` for transient subscriptions.

```typescript
import { Connection } from "@sparetimecoders/messaging-nats";

const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "notifications",
});

// Publisher
const pub = conn.addEventPublisher();

// Durable consumer (default)
conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  console.log(`Order ${event.payload.orderId}`);
});

// Ephemeral consumer
conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  console.log(`Temporary listener: ${event.payload.orderId}`);
}, { ephemeral: true });

// Consumer with queue suffix (multiple routing keys on separate consumers)
conn.addEventConsumer<OrderUpdated>("Order.Updated", async (event) => {
  console.log(`Updated: ${event.payload.orderId}`);
}, { queueSuffix: "updates" });

await conn.start();
await pub.publish("Order.Created", { orderId: "abc-123", amount: 42 });
```

### Custom Stream

Same as event stream, but on a named stream instead of the default `events` stream. Use when events belong to a separate domain (e.g., `audit`, `telemetry`).

```typescript
const pub = conn.addCustomStreamPublisher("audit");

conn.addCustomStreamConsumer<AuditEntry>("audit", "User.Login", async (event) => {
  console.log(`Login from ${event.payload.userId}`);
});

await conn.start();
await pub.publish("User.Login", { userId: "u-42", ip: "10.0.0.1" });
```

### Service Request-Response

Synchronous request-reply between services using Core NATS. The consumer returns a value that is sent back to the caller.

```typescript
// --- Billing service ---
const billing = new Connection({
  url: "nats://localhost:4222",
  serviceName: "billing",
});

billing.addServiceRequestConsumer<InvoiceRequest, Invoice>(
  "Invoice.Generate",
  async (event) => {
    return { invoiceId: "inv-001", total: event.payload.amount };
  },
);

await billing.start();

// --- Order service (caller) ---
const orders = new Connection({
  url: "nats://localhost:4222",
  serviceName: "orders",
});

const billingPub = orders.addServiceRequestPublisher("billing");

await orders.start();

// publish() sends the request and waits for the response
await billingPub.publish("Invoice.Generate", { amount: 99 });
```

### Service Response

In NATS, request-reply responses are handled automatically by the Core NATS `request()` call. The `addServiceResponseConsumer` method exists for topology registration so that cross-service validation and visualization work correctly.

```typescript
conn.addServiceResponseConsumer<Invoice>("billing", "Invoice.Generate", async (event) => {
  console.log(`Got invoice: ${event.payload.invoiceId}`);
});
```

## Configuration

### ConnectionOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | (required) | NATS connection URL (e.g., `"nats://localhost:4222"`) |
| `serviceName` | `string` | (required) | Service name for subscription/queue naming |
| `logger` | `Pick<Console, "info" \| "warn" \| "error" \| "debug">` | `console` | Logger instance |
| `propagator` | `TextMapPropagator` | global OTel | OpenTelemetry propagator for trace context |
| `requestTimeout` | `number` | `30000` | Timeout in ms for Core NATS request-reply operations |
| `streamDefaults` | `StreamConfig` | `{}` | Default retention limits applied to all streams |
| `streamConfigs` | `Record<string, StreamConfig>` | `{}` | Per-stream retention limit overrides (keyed by stream name) |
| `consumerDefaults` | `ConsumerDefaults` | `{}` | Default MaxDeliver and BackOff for all JetStream consumers |
| `onNotification` | `NotificationHandler` | &mdash; | Callback after a consumer handler completes successfully |
| `onError` | `ErrorNotificationHandler` | &mdash; | Callback after a consumer handler fails |
| `metrics` | `MetricsRecorder` | &mdash; | Metrics recorder for instrumentation |
| `routingKeyMapper` | `RoutingKeyMapper` | &mdash; | Routing key mapper applied before passing keys to metrics |
| `natsOptions` | `Partial<Omit<NatsConnectionOptions, "servers">>` | `{}` | Pass-through options for the underlying NATS client (reconnection, etc.) |
| `onReconnect` | `() => void` | &mdash; | Callback when the client reconnects to the NATS server |
| `onDisconnect` | `(error: Error) => void` | &mdash; | Callback when the client disconnects from the NATS server |

### Stream Configuration

Streams have retention limits that control how long messages are kept. The `StreamConfig` type defines these limits:

```typescript
interface StreamConfig {
  maxAge?: number;   // Maximum age in nanoseconds (0 = unlimited)
  maxBytes?: number; // Maximum total size in bytes (0 = unlimited)
  maxMsgs?: number;  // Maximum number of messages (0 = unlimited)
}
```

`DefaultStreamConfig` provides sensible defaults matching the Go implementation:

| Field | Value |
|-------|-------|
| `maxAge` | 7 days (604,800,000,000,000 ns) |
| `maxBytes` | 1 GiB (1,073,741,824 bytes) |
| `maxMsgs` | 1,000,000 |

Use `streamDefaults` to apply limits to all streams, and `streamConfigs` for per-stream overrides. Per-stream configs replace defaults entirely (no field-level merging).

```typescript
import { Connection, DefaultStreamConfig } from "@sparetimecoders/messaging-nats";

const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  streamDefaults: DefaultStreamConfig,
  streamConfigs: {
    audit: { maxAge: 30 * 24 * 60 * 60 * 1e9, maxBytes: 10_737_418_240 }, // 30 days, 10 GiB
  },
});
```

### Consumer Options

Per-consumer options override connection-level `consumerDefaults`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ephemeral` | `boolean` | `false` | If true, creates an ephemeral (non-durable) consumer |
| `queueSuffix` | `string` | &mdash; | Appended to the durable name for consumer isolation |
| `maxDeliver` | `number` | unlimited | Maximum number of delivery attempts before giving up |
| `backOff` | `number[]` | &mdash; | Redelivery backoff durations in milliseconds |

Set connection-level defaults with `consumerDefaults`:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  consumerDefaults: {
    maxDeliver: 5,
    backOff: [1000, 5000, 30000], // 1s, 5s, 30s
  },
});

// Override per-consumer
conn.addEventConsumer("Order.Created", handler, {
  maxDeliver: 10,
  backOff: [500, 2000, 10000],
});
```

## Observability

### Tracing

OpenTelemetry trace context propagation is built in. Pass a `TextMapPropagator` via the `propagator` option, or the global OTel propagator is used by default.

Trace context is injected into NATS headers on publish and extracted on consume. The helper functions are also exported for direct use:

```typescript
import { injectToHeaders, extractToContext } from "@sparetimecoders/messaging-nats";

// Inject OTel context into NATS headers
injectToHeaders(otelContext, natsHeaders, propagator);

// Extract OTel context from NATS headers
const ctx = extractToContext(natsHeaders, propagator);
```

### Metrics

Implement the `MetricsRecorder` interface from `@sparetimecoders/messaging` and pass it via the `metrics` option. The transport records:

- `eventReceived` / `eventAck` / `eventNack` per consumer
- `publishSucceed` / `publishFailed` per publisher
- Processing and publish durations in milliseconds

### Notifications

Use `onNotification` and `onError` callbacks to hook into consumer lifecycle events:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  onNotification: ({ deliveryInfo, durationMs }) => {
    console.log(`Processed ${deliveryInfo.key} in ${durationMs}ms`);
  },
  onError: ({ deliveryInfo, durationMs, error }) => {
    console.error(`Failed ${deliveryInfo.key} after ${durationMs}ms: ${error.message}`);
  },
});
```

## NATS-Specific Features

**JetStream vs Core NATS** -- The transport automatically selects the right protocol based on the messaging pattern. Event streams and custom streams use JetStream for durable, at-least-once delivery. Service request-response uses Core NATS for low-latency request-reply.

**Stream retention** -- Streams are created with configurable retention limits (`maxAge`, `maxBytes`, `maxMsgs`). Use `DefaultStreamConfig` for sensible defaults (7 days, 1 GiB, 1M messages). The transport warns at startup if a stream has no retention limits configured.

**Consumer delivery limits and backoff** -- Configure `maxDeliver` and `backOff` at the connection level via `consumerDefaults`, or override per-consumer. Backoff durations are specified in milliseconds and converted to nanoseconds for the NATS server.

**Consumer grouping** -- Multiple routing keys registered on the same stream and durable name are grouped into a single NATS consumer with multiple `filter_subjects`. This matches AMQP's one-queue, many-bindings model. Messages are dispatched to the correct handler based on routing key matching.

**Connection monitoring** -- Use `onReconnect` and `onDisconnect` callbacks to react to connection state changes. Pass-through `natsOptions` allows configuring reconnection behavior (`maxReconnectAttempts`, `reconnectTimeWait`, `reconnectJitter`, etc.).

## Topology Export

The `topology()` method returns a `Topology` object describing all declared publishers and consumers. This enables cross-service validation and Mermaid diagram generation via the spec tooling.

```typescript
const topo = conn.topology();
// { transport: "nats", serviceName: "order-service", endpoints: [...] }
```

## Development

```bash
docker compose up -d   # Start NATS with JetStream
npm install
npm test
```

## TCK Adapter

The `tck-adapter/` directory contains a [Technology Compatibility Kit](https://github.com/sparetimecoders/messaging) adapter that implements the JSON-RPC subprocess protocol for conformance testing against the shared spec.

## License

MIT
