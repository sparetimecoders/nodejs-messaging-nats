# Request-Response

The request-response pattern uses **Core NATS** request-reply. The caller publishes a request and waits for a response on an auto-generated reply subject.

## Handler Side

```typescript
conn.addServiceRequestConsumer<InvoiceRequest, InvoiceResponse>(
  "Invoice.Create",
  async (event) => {
    const invoice = await createInvoice(event.payload.orderId);
    return { invoiceId: invoice.id, total: invoice.total };
  },
);
```

The return value is serialized to JSON and sent to the reply subject automatically.

### Error Handling

| Handler outcome | Behavior |
|----------------|----------|
| Promise resolves with value | Response sent to caller |
| Promise rejects | Error JSON sent to caller |

Unlike AMQP, errors are sent back as JSON — the caller always gets a response (success or error).

## Caller Side

```typescript
const pub = conn.addServiceRequestPublisher("billing-service");

conn.addServiceResponseConsumer<InvoiceResponse>(
  "billing-service",
  "Invoice.Create",
  async (event) => {
    console.log("invoice:", event.payload.invoiceId);
  },
);

await conn.start();

await pub.publish("Invoice.Create", { orderId: "abc-123" });
```

### Request Timeout

```typescript
const conn = new Connection({
  url: "nats://localhost:4222",
  serviceName: "order-service",
  requestTimeout: 10000,  // 10 seconds
});
```

Default: 30 seconds. If no response arrives within the timeout, `publish()` rejects.

## Subject Naming

| Resource | Subject | Example |
|----------|---------|---------|
| Request | `{service}.request.{routingKey}` | `billing.request.Invoice.Create` |
| Response | NATS reply subject (automatic) | `_INBOX.abc123` |

## Comparison with AMQP

| | AMQP | NATS |
|---|------|------|
| Request routing | Direct exchange | Core NATS subject |
| Response routing | Headers exchange | Built-in reply subject |
| Response queue | Explicit per-caller | Automatic (NATS inbox) |
| Timeout | Application-level | Built into Core NATS |
| Error response | No response, request NACKed | Error JSON sent to caller |
| Persistence | Quorum queues | Not persisted (Core NATS) |

The NATS approach is simpler — no exchange or queue declaration needed.
