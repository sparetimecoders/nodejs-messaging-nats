# Observability

## Tracing

Trace context propagates through NATS message headers using OpenTelemetry.

### Setup

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  propagator: myPropagator,
});
```

Default: globally registered OpenTelemetry propagator.

### Exported Helpers

```typescript
import { injectToHeaders, extractToContext } from "@sparetimecoders/messaging-nats";

// Inject active span into NATS headers
const headers = injectToHeaders(context.active(), natsHeaders);

// Extract span context from received headers
const ctx = extractToContext(msg.headers);
```

## Metrics

Implement the `MetricsRecorder` interface from `@gomessaging/spec`:

```typescript
import { MetricsRecorder } from "@gomessaging/spec";

const metrics: MetricsRecorder = {
  publishSucceed(stream, routingKey, durationMs) { /* counter++ */ },
  publishFailed(stream, routingKey, durationMs) { /* counter++ */ },
  eventReceived(consumer, routingKey) { /* counter++ */ },
  eventAck(consumer, routingKey, durationMs) { /* counter++ */ },
  eventNack(consumer, routingKey, durationMs) { /* counter++ */ },
  eventNotParsable(consumer, routingKey) { /* counter++ */ },
  eventWithoutHandler(consumer, routingKey) { /* counter++ */ },
};

const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  metrics,
  routingKeyMapper: (key) => key.replace(/[a-f0-9-]{36}/g, "<id>"),
});
```

### Routing Key Mapper

Normalize dynamic routing key segments before they become metric labels:

```typescript
routingKeyMapper: (key) => key.replace(/[a-f0-9-]{36}/g, "<id>")
```

## Notifications

Per-message callbacks:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",

  onNotification: ({ deliveryInfo, durationMs }) => {
    console.log(`processed ${deliveryInfo.key} in ${durationMs}ms`);
  },

  onError: ({ deliveryInfo, error, durationMs }) => {
    console.error(`failed ${deliveryInfo.key}: ${error.message}`);
  },
});
```

## Connection Monitoring

NATS has built-in reconnection. Monitor connection state:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  onDisconnect: (err) => console.error("disconnected:", err.message),
  onReconnect: () => console.log("reconnected"),
});
```

## Observability Across Transports

The metrics and notification interfaces are identical between @sparetimecoders/messaging-amqp and @sparetimecoders/messaging-nats. The same `MetricsRecorder` implementation works with both transports — only the label values differ:

| | AMQP | NATS |
|---|------|------|
| Consumer label value | Queue name | Consumer name |
| Publisher label value | Exchange name | Stream name |
