import { describe, expect, it, vi, beforeEach } from "vitest";
import { startCoreConsumers, startJSConsumers } from "../src/consumer.js";
import type { CoreConsumerRegistration, JSConsumerRegistration } from "../src/consumer.js";
import { AckPolicy } from "nats";

// Minimal mock for NatsConnection subscribe
function createMockNc() {
  const subscriptions: Array<{
    subject: string;
    callback: (err: null, msg: unknown) => void;
  }> = [];

  return {
    nc: {
      subscribe: vi.fn((subject: string, opts: { callback: (err: null, msg: unknown) => void }) => {
        subscriptions.push({ subject, callback: opts.callback });
        return { unsubscribe: vi.fn() };
      }),
    },
    subscriptions,
  };
}

function createMockMsg(data: unknown, headers?: Record<string, string>, reply?: string) {
  const hdrs = new Map<string, string[]>();
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      hdrs.set(k, [v]);
    }
  }
  const headerObj = {
    get(k: string): string {
      const vals = hdrs.get(k);
      return vals?.[0] ?? "";
    },
    has(k: string): boolean {
      return hdrs.has(k);
    },
    keys(): string[] {
      return [...hdrs.keys()];
    },
    [Symbol.iterator]() {
      return hdrs.entries();
    },
  };
  return {
    subject: "test-service.request.get-order",
    data: new TextEncoder().encode(JSON.stringify(data)),
    headers: headerObj,
    reply: reply ?? "",
    respond: vi.fn(),
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("JetStream consumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockJsAndJsm() {
    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        // no messages in test
      },
    };

    const mockConsumer = {
      consume: vi.fn().mockResolvedValue(mockMessages),
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue(mockConsumer),
      },
    };

    const jsm = {
      streams: {
        add: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      consumers: {
        add: vi.fn().mockImplementation((_stream: string, cfg: { durable_name?: string }) => {
          return Promise.resolve({ name: cfg.durable_name ?? `ephemeral-${Date.now()}` });
        }),
        delete: vi.fn().mockResolvedValue(true),
      },
    };

    return { js, jsm, mockConsumer, mockMessages };
  }

  it("creates single consumer with filter_subject for one registration", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "node-demo",
      },
    ];

    await startJSConsumers(js as never, jsm as never, "node-demo", registrations, silentLogger);

    // Should create stream
    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "events",
      subjects: ["events.>"],
    });

    // Single registration uses filter_subject (singular)
    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "node-demo",
    });

    expect(js.consumers.get).toHaveBeenCalledWith("events", "node-demo");
  });

  it("groups registrations with same durable into one consumer with filter_subjects", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "node-demo",
      },
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
        handler: async () => {},
        durable: "node-demo",
      },
    ];

    const handles = await startJSConsumers(js as never, jsm as never, "node-demo", registrations, silentLogger);

    // Should create only ONE consumer (grouped)
    expect(jsm.consumers.add).toHaveBeenCalledOnce();
    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subjects: ["events.Order.Created", "events.Ping"],
      ack_policy: AckPolicy.Explicit,
      durable_name: "node-demo",
    });

    // Only one NATS consumer handle
    expect(js.consumers.get).toHaveBeenCalledOnce();
    expect(handles).toHaveLength(1);
  });

  it("creates ephemeral consumer without durable_name", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
        handler: async () => {},
        // no durable
      },
    ];

    await startJSConsumers(js as never, jsm as never, "node-demo", registrations, silentLogger);

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Ping",
      ack_policy: AckPolicy.Explicit,
    });
  });

  it("returns handles that stop consuming", async () => {
    const { js, jsm, mockMessages } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-durable",
      },
    ];

    const handles = await startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger);

    expect(handles).toHaveLength(1);
    handles[0].stop();
    expect(mockMessages.stop).toHaveBeenCalledOnce();
  });

  it("handles stream already existing", async () => {
    const { js, jsm } = createMockJsAndJsm();
    jsm.streams.add.mockRejectedValueOnce(new Error("stream already exists"));

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
        handler: async () => {},
        durable: "test-durable",
      },
    ];

    await startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger);

    expect(jsm.streams.update).toHaveBeenCalledWith("events", {
      subjects: ["events.>"],
    });

    expect(jsm.consumers.add).toHaveBeenCalledOnce();
  });

  it("deletes and recreates when consumer already exists with incompatible config", async () => {
    const { js, jsm } = createMockJsAndJsm();
    jsm.consumers.add.mockRejectedValueOnce(new Error("consumer already exists"));

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-durable",
      },
    ];

    await startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger);

    // Should delete the old consumer
    expect(jsm.consumers.delete).toHaveBeenCalledWith("events", "test-durable");

    // Then recreate it (second add call)
    expect(jsm.consumers.add).toHaveBeenCalledTimes(2);

    expect(js.consumers.get).toHaveBeenCalledWith("events", "test-durable");
  });

  it("dispatches messages using wildcard pattern matching", async () => {
    const received: unknown[] = [];
    const acked: boolean[] = [];
    const nacked: boolean[] = [];

    // Create a mock message iterator that yields one message
    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "999" })),
          headers: (() => {
            const entries: Array<[string, string[]]> = [
              ["ce-specversion", ["1.0"]],
              ["ce-type", ["Order.Created"]],
              ["ce-source", ["test"]],
              ["ce-id", ["id-1"]],
              ["ce-time", ["2026-01-01T00:00:00Z"]],
            ];
            const map = new Map(entries);
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() { acked.push(true); },
          nak() { nacked.push(true); },
          term() {},
        };
      },
    };

    const mockConsumer = {
      consume: vi.fn().mockResolvedValue(mockMessages),
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue(mockConsumer),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: {
        add: vi.fn().mockImplementation((_stream: string, cfg: { durable_name?: string }) => {
          return Promise.resolve({ name: cfg.durable_name ?? `ephemeral-${Date.now()}` });
        }),
        delete: vi.fn().mockResolvedValue(true),
      },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.#",
        handler: async (event) => { received.push(event.payload); },
        durable: "wildcard-svc",
      },
    ];

    await startJSConsumers(js as never, jsm as never, "wildcard-svc", registrations, silentLogger);

    // Wait for the async message processing
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    expect(received[0]).toEqual({ orderId: "999" });
    expect(acked).toHaveLength(1);
    expect(nacked).toHaveLength(0);
  });

  it("creates separate consumers for different streams", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "node-demo",
      },
      {
        kind: "jetstream",
        stream: "custom",
        routingKey: "Alert",
        handler: async () => {},
        durable: "node-demo",
      },
    ];

    const handles = await startJSConsumers(js as never, jsm as never, "node-demo", registrations, silentLogger);

    // Different streams = different groups = two consumers
    expect(jsm.consumers.add).toHaveBeenCalledTimes(2);
    expect(js.consumers.get).toHaveBeenCalledTimes(2);
    expect(handles).toHaveLength(2);
  });
});

describe("Core consumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a subscription for each registration", () => {
    const { nc } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => {},
        requestReply: false,
      },
      {
        kind: "core",
        subject: "svc.request.get-user",
        routingKey: "get-user",
        handler: async () => {},
        requestReply: false,
      },
    ];

    const handles = startCoreConsumers(
      nc as never,
      "test-service",
      registrations,
      silentLogger,
    );

    expect(nc.subscribe).toHaveBeenCalledTimes(2);
    expect(handles).toHaveLength(2);
  });

  it("dispatches messages to handler", async () => {
    const { nc, subscriptions } = createMockNc();
    const received: unknown[] = [];

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async (event) => {
          received.push(event.payload);
        },
        requestReply: false,
      },
    ];

    startCoreConsumers(nc as never, "test-service", registrations, silentLogger);

    const msg = createMockMsg({ orderId: "123" }, {
      "ce-specversion": "1.0",
      "ce-type": "get-order",
      "ce-source": "client",
      "ce-id": "test-id",
      "ce-time": "2026-01-01T00:00:00Z",
    });

    // Trigger the subscription callback
    await subscriptions[0].callback(null, msg);

    expect(received).toEqual([{ orderId: "123" }]);
  });

  it("sends response for request-reply handlers", async () => {
    const { nc, subscriptions } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => ({ status: "found", orderId: "123" }),
        requestReply: true,
      },
    ];

    startCoreConsumers(nc as never, "test-service", registrations, silentLogger);

    const msg = createMockMsg(
      { orderId: "123" },
      {
        "ce-specversion": "1.0",
        "ce-type": "get-order",
        "ce-source": "client",
        "ce-id": "test-id",
        "ce-time": "2026-01-01T00:00:00Z",
      },
      "_INBOX.reply",
    );

    await subscriptions[0].callback(null, msg);

    expect(msg.respond).toHaveBeenCalledOnce();
    const respData = msg.respond.mock.calls[0][0];
    expect(JSON.parse(new TextDecoder().decode(respData))).toEqual({
      status: "found",
      orderId: "123",
    });
  });

  it("sends error response on handler failure for request-reply", async () => {
    const { nc, subscriptions } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => {
          throw new Error("not found");
        },
        requestReply: true,
      },
    ];

    startCoreConsumers(nc as never, "test-service", registrations, silentLogger);

    const msg = createMockMsg(
      { orderId: "999" },
      {
        "ce-specversion": "1.0",
        "ce-type": "get-order",
        "ce-source": "client",
        "ce-id": "test-id",
        "ce-time": "2026-01-01T00:00:00Z",
      },
      "_INBOX.reply",
    );

    await subscriptions[0].callback(null, msg);

    expect(msg.respond).toHaveBeenCalledOnce();
    const respData = msg.respond.mock.calls[0][0];
    expect(JSON.parse(new TextDecoder().decode(respData))).toEqual({
      error: "not found",
    });
  });

  it("extracts metadata from CE headers", async () => {
    const { nc, subscriptions } = createMockNc();
    let capturedEvent: unknown = null;

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async (event) => {
          capturedEvent = event;
        },
        requestReply: false,
      },
    ];

    startCoreConsumers(nc as never, "test-service", registrations, silentLogger);

    const msg = createMockMsg(
      { data: true },
      {
        "ce-specversion": "1.0",
        "ce-type": "get-order",
        "ce-source": "client-service",
        "ce-id": "msg-id-123",
        "ce-time": "2026-06-15T10:30:00Z",
        "ce-datacontenttype": "application/json",
      },
    );

    await subscriptions[0].callback(null, msg);

    const event = capturedEvent as {
      type: string;
      source: string;
      id: string;
      specVersion: string;
      timestamp: string;
      dataContentType: string;
    };
    expect(event.type).toBe("get-order");
    expect(event.source).toBe("client-service");
    expect(event.id).toBe("msg-id-123");
    expect(event.specVersion).toBe("1.0");
    expect(event.timestamp).toBe("2026-06-15T10:30:00Z");
    expect(event.dataContentType).toBe("application/json");
  });

  it("logs error on invalid JSON payload", async () => {
    const { nc, subscriptions } = createMockNc();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.test",
        routingKey: "test",
        handler: async () => {},
        requestReply: false,
      },
    ];

    startCoreConsumers(nc as never, "test-service", registrations, logger);

    // Send invalid JSON
    const msg = {
      subject: "svc.request.test",
      data: new TextEncoder().encode("not json{"),
      headers: {
        get: () => "",
        has: () => false,
        keys: () => [],
        [Symbol.iterator]: function* () {},
      },
      reply: "",
      respond: vi.fn(),
    };

    await subscriptions[0].callback(null, msg);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse"),
    );
  });

  it("handles stop() for cleanup", () => {
    const { nc } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => {},
        requestReply: false,
      },
    ];

    const handles = startCoreConsumers(
      nc as never,
      "test-service",
      registrations,
      silentLogger,
    );

    // Should not throw
    handles[0].stop();
    const sub = (nc.subscribe as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
  });
});
