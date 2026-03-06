# Connection & Configuration

## Creating a Connection

```typescript
import { Connection } from "@sparetimecoders/messaging-nats";

const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
});
```

Register publishers and consumers before calling `start()`:

```typescript
const pub = conn.addEventPublisher();

conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  console.log(event.payload.orderId);
});

await conn.start();
```

## Connection Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | required | NATS server URL |
| `serviceName` | `string` | required | Service name for consumer/subject naming |
| `logger` | `Logger` | `console` | Logger with `info`, `warn`, `error`, `debug` |
| `propagator` | `TextMapPropagator` | global OTel | OpenTelemetry trace context propagator |
| `requestTimeout` | `number` | `30000` | Timeout for Core NATS request-reply (ms) |
| `streamDefaults` | `StreamConfig` | `{}` | Default retention limits for all streams |
| `streamConfigs` | `Record<string, StreamConfig>` | `{}` | Per-stream retention overrides |
| `consumerDefaults` | `ConsumerDefaults` | `{}` | Default MaxDeliver and BackOff |
| `onNotification` | `NotificationHandler` | — | Callback after handler success |
| `onError` | `ErrorNotificationHandler` | — | Callback after handler failure |
| `metrics` | `MetricsRecorder` | — | Metrics recorder for instrumentation |
| `routingKeyMapper` | `RoutingKeyMapper` | — | Normalize routing keys for metrics labels |
| `natsOptions` | `Partial<NatsConnectionOptions>` | `{}` | Pass-through options for NATS client |
| `onReconnect` | `() => void` | — | Callback on reconnection |
| `onDisconnect` | `(error: Error) => void` | — | Callback on disconnection |

## Startup Sequence

`start()` performs these steps:

1. Connects to the NATS server
2. Creates a JetStream management context
3. Creates or updates JetStream streams with configured retention
4. Creates durable consumers with filter subjects
5. Subscribes to Core NATS subjects for request-reply
6. Starts consuming messages

## Connection Monitoring

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  onDisconnect: (err) => {
    console.error("disconnected:", err.message);
  },
  onReconnect: () => {
    console.log("reconnected");
  },
});
```

NATS has built-in reconnection. Unlike AMQP, disconnects are often transient — the client reconnects automatically.

### Pass-Through NATS Options

Configure reconnection behavior, TLS, authentication via `natsOptions`:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  natsOptions: {
    maxReconnectAttempts: 10,
    reconnectTimeWait: 2000,
    tls: { caFile: "/path/to/ca.pem" },
  },
});
```

## Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  await conn.close();
});
```

`close()` drains the NATS connection — it waits for in-flight messages to finish processing before disconnecting.

## Topology Export

Inspect declared topology without connecting:

```typescript
const topology = conn.topology();
// { transport: "nats", serviceName: "order-service", endpoints: [...] }
```

Use with the spec module:

```typescript
import { validate, mermaid } from "@sparetimecoders/messaging";

const errors = validate(topology);
const diagram = mermaid([topology]);
```
