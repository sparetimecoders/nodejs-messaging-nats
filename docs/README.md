# @sparetimecoders/messaging-nats Documentation

Detailed guides for the Node.js NATS/JetStream transport. For a quick overview, see the [main README](../README.md).

| Guide | Description |
|-------|-------------|
| [Connection & Configuration](connection.md) | Creating connections, all options, lifecycle |
| [Consumers](consumers.md) | Durable and ephemeral consumers, error handling, redelivery |
| [Publishers](publishers.md) | Publishing messages, custom headers |
| [Request-Response](request-response.md) | Synchronous RPC using Core NATS |
| [Streams & Retention](streams.md) | JetStream stream configuration, retention policies |
| [Observability](observability.md) | Tracing, metrics, notifications |

## Related

- [gomessaging specification](https://github.com/sparetimecoders/messaging) — shared spec, TCK, validation, visualization
- [gomessaging/nats (Go)](https://github.com/sparetimecoders/go-messaging-nats) — Go NATS transport
- [@sparetimecoders/messaging-amqp](https://github.com/sparetimecoders/nodejs-messaging-amqp) — Node.js AMQP transport
