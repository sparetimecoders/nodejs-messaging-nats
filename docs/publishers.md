# Publishers

Publishers send JSON-encoded messages with CloudEvents headers. JetStream is used for event and custom streams; Core NATS is used for request-reply.

## Creating Publishers

### Event Stream Publisher

```typescript
const pub = conn.addEventPublisher();
// Publishes to JetStream stream "events"
```

### Custom Stream Publisher

```typescript
const pub = conn.addCustomStreamPublisher("audit");
// Publishes to JetStream stream "audit"
```

### Service Request Publisher

```typescript
const pub = conn.addServiceRequestPublisher("billing-service");
// Publishes to Core NATS subject billing-service.request.{routingKey}
```

## Publishing Messages

```typescript
await pub.publish("Order.Created", {
  orderId: "abc-123",
  amount: 42,
});
```

With custom headers:

```typescript
await pub.publish("Order.Created", payload, {
  "priority": "high",
  "region": "eu-west-1",
});
```

With trace context:

```typescript
import { context } from "@opentelemetry/api";

await pub.publish("Order.Created", payload, context.active());
await pub.publish("Order.Created", payload, context.active(), { priority: "high" });
```

## Wire Format

NATS message headers:

| Header | Value |
|--------|-------|
| `ce_specversion` | `1.0` |
| `ce_type` | routing key |
| `ce_source` | service name |
| `ce_id` | UUID v4 |
| `ce_time` | ISO 8601 UTC |
| `ce_datacontenttype` | `application/json` |
| `service` | service name |

NATS uses underscore-separated CE header names (`ce_type`, not `ce-type` or `cloudEvents:type`).

## Subject Naming

| Pattern | Subject format | Example |
|---------|---------------|---------|
| Event stream | `events.{routingKey}` | `events.Order.Created` |
| Custom stream | `{stream}.{routingKey}` | `audit.User.Login` |
| Service request | `{service}.request.{routingKey}` | `billing.request.Invoice.Create` |

## CloudEvents Header Defaults

Headers use a "set default" pattern — only set if not already present. Override any attribute:

```typescript
await pub.publish("Order.Created", payload, {
  "ce_id": "my-custom-id",
  "ce_source": "external-system",
});
```
