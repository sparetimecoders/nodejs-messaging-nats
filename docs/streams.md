# Streams & Retention

Event and custom stream patterns use **JetStream** for durable message storage. Streams need retention limits to prevent unbounded growth.

## Stream Configuration

### Default Retention

Apply default limits to all streams:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  streamDefaults: {
    maxAge: 604_800_000_000_000,  // 7 days in nanoseconds
    maxBytes: 1_073_741_824,       // 1 GiB
    maxMsgs: 1_000_000,           // 1 million messages
  },
});
```

### Per-Stream Overrides

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  streamDefaults: { maxAge: 604_800_000_000_000 },
  streamConfigs: {
    audit: {
      maxAge: 7_776_000_000_000_000,  // 90 days
      maxBytes: 10_737_418_240,        // 10 GiB
    },
  },
});
```

Per-stream config replaces defaults entirely for that stream (no field-level merging).

### Recommended Defaults

The `DefaultStreamConfig` constant provides sensible defaults:

```typescript
import { DefaultStreamConfig } from "@sparetimecoders/messaging-nats";

// { maxAge: 604800000000000, maxBytes: 1073741824, maxMsgs: 1000000 }
// 7 days, 1 GiB, 1 million messages
```

## StreamConfig Fields

| Field | Type | Zero value | Description |
|-------|------|------------|-------------|
| `maxAge` | `number` | unlimited | Max message age (nanoseconds) |
| `maxBytes` | `number` | unlimited | Max total size (bytes) |
| `maxMsgs` | `number` | unlimited | Max message count |

When multiple limits are set, whichever is hit first triggers cleanup.

## Consumer Defaults

Configure redelivery behavior for all consumers:

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  consumerDefaults: {
    maxDeliver: 5,
    backOff: [1000, 5000, 30000],  // milliseconds
  },
});
```

Per-consumer options override these defaults. See [Consumers](consumers.md).

## Stream Storage

All JetStream streams use **FileStorage** for durability. Streams are created automatically during `start()` when publishers or consumers are registered. If a stream already exists, its configuration is updated.

## Subject Mapping

Each stream accepts messages on subjects matching `{stream}.>`:

| Stream | Subjects |
|--------|----------|
| `events` | `events.Order.Created`, `events.Payment.Completed`, ... |
| `audit` | `audit.User.Login`, `audit.Config.Changed`, ... |
