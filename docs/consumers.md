# Consumers

Consumers are registered on the connection before calling `start()`. JetStream durable consumers are used for event and custom streams; Core NATS subscriptions are used for request-reply.

## Consumer Types

### Durable Event Consumer

Subscribes to the `events` JetStream stream. Survives restarts:

```typescript
conn.addEventConsumer<OrderCreated>("Order.Created", async (event) => {
  await processOrder(event.payload);
});
```

### Ephemeral Event Consumer

Non-durable consumer removed on disconnect:

```typescript
conn.addEventConsumer("Order.*", async (event) => {
  console.log("event:", event.deliveryInfo.key);
}, { ephemeral: true });
```

### Custom Stream Consumer

Subscribe to a named stream:

```typescript
conn.addCustomStreamConsumer<UserLogin>("audit", "User.Login", async (event) => {
  await recordAuditEntry(event.payload);
});
```

### Service Request/Response Consumers

See [Request-Response](request-response.md).

## Handler Contract

```typescript
type EventHandler<T> = (event: ConsumableEvent<T>) => Promise<void>;
```

### Acknowledgment

| Handler outcome | NATS action |
|----------------|-------------|
| Promise resolves | Message **ACK** |
| JSON parse failure | Message **terminated** (no redelivery) |
| Other error | Message **NAK** (redelivered per backoff) |

Unlike AMQP where rejected messages are requeued immediately, NATS supports configurable backoff for redelivery (see [Streams & Retention](streams.md)).

## Consumer Options

```typescript
conn.addEventConsumer("Order.Created", handler, {
  maxDeliver: 5,
  backOff: [1000, 5000, 30000],
  queueSuffix: "priority",
  ephemeral: false,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ephemeral` | `boolean` | `false` | Non-durable consumer |
| `queueSuffix` | `string` | — | Suffix for durable consumer name |
| `maxDeliver` | `number` | unlimited | Max delivery attempts |
| `backOff` | `number[]` | — | Redelivery backoff (ms) |

Per-consumer options override `consumerDefaults` from the connection.

### Queue Suffix

When the same service needs multiple consumers for the same routing key:

```typescript
conn.addEventConsumer("Order.Created", priorityHandler, { queueSuffix: "priority" });
conn.addEventConsumer("Order.Created", batchHandler, { queueSuffix: "batch" });
```

### Redelivery

```typescript
conn.addEventConsumer("Order.Created", handler, {
  maxDeliver: 5,
  backOff: [1000, 5000, 30000],  // 1s, 5s, 30s
});
```

After 5 attempts, the message is dropped. The backoff schedule repeats the last value for attempts beyond the schedule length.

## Consumer Grouping

Multiple routing keys on the same stream are grouped into a **single JetStream consumer** with multiple filter subjects:

```typescript
// Creates ONE consumer with TWO filter subjects
conn.addEventConsumer("Order.Created", handler1);
conn.addEventConsumer("Order.Shipped", handler2);
```

Messages are dispatched to the correct handler based on subject matching.

## Wildcard Routing

NATS wildcards:

| Pattern | Matches |
|---------|---------|
| `Order.Created` | Exactly `Order.Created` |
| `Order.*` | `Order.Created`, `Order.Updated` (one segment) |
| `Order.>` | `Order.Created`, `Order.Item.Added` (any depth) |

The spec translates AMQP `#` to NATS `>` automatically.
