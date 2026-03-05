import { describe, expect, it, vi, beforeEach } from "vitest";
import { startJSConsumers, startCoreConsumers } from "../src/consumer.js";
import { Publisher } from "../src/publisher.js";
import type { MetricsRecorder } from "@gomessaging/spec";
import type { JSConsumerRegistration, CoreConsumerRegistration } from "../src/consumer.js";

function createMockMetrics(): MetricsRecorder & { [K in keyof MetricsRecorder]: ReturnType<typeof vi.fn> } {
  return {
    eventReceived: vi.fn(),
    eventWithoutHandler: vi.fn(),
    eventNotParsable: vi.fn(),
    eventAck: vi.fn(),
    eventNack: vi.fn(),
    publishSucceed: vi.fn(),
    publishFailed: vi.fn(),
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

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

function createMockMsg(data: unknown, headers?: Record<string, string>) {
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
    reply: "",
    respond: vi.fn(),
  };
}

const ceHeaders = {
  "ce-specversion": "1.0",
  "ce-type": "get-order",
  "ce-source": "client",
  "ce-id": "test-id",
  "ce-time": "2026-01-01T00:00:00Z",
};

describe("NATS JetStream Consumer Metrics", () => {
  let metrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    metrics = createMockMetrics();
    vi.clearAllMocks();
  });

  it("calls eventReceived and eventAck on successful handler", async () => {
    const received: unknown[] = [];
    const acked: boolean[] = [];

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "999" })),
          headers: (() => {
            const map = new Map([
              ["ce-specversion", ["1.0"]],
              ["ce-type", ["Order.Created"]],
              ["ce-source", ["test"]],
              ["ce-id", ["id-1"]],
              ["ce-time", ["2026-01-01T00:00:00Z"]],
            ]);
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() { acked.push(true); },
          nak() {},
          term() {},
        };
      },
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: vi.fn().mockResolvedValue(mockMessages),
        }),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: { add: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(true) },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.#",
        handler: async (event) => { received.push(event.payload); },
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never, jsm as never, "test-svc", registrations, silentLogger,
      undefined, undefined, undefined, undefined, undefined,
      metrics,
    );

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-svc", "Order.Created");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-svc", "Order.Created", expect.any(Number),
    );
  });

  it("calls eventNack on handler error", async () => {
    const nacked: boolean[] = [];

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "999" })),
          headers: (() => {
            const map = new Map([
              ["ce-specversion", ["1.0"]],
              ["ce-type", ["Order.Created"]],
              ["ce-source", ["test"]],
              ["ce-id", ["id-1"]],
              ["ce-time", ["2026-01-01T00:00:00Z"]],
            ]);
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() {},
          nak() { nacked.push(true); },
          term() {},
        };
      },
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: vi.fn().mockResolvedValue(mockMessages),
        }),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: { add: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(true) },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => { throw new Error("handler failed"); },
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never, jsm as never, "test-svc", registrations, silentLogger,
      undefined, undefined, undefined, undefined, undefined,
      metrics,
    );

    await vi.waitFor(() => {
      expect(nacked).toHaveLength(1);
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-svc", "Order.Created");
    expect(metrics.eventNack).toHaveBeenCalledWith(
      "test-svc", "Order.Created", expect.any(Number),
    );
  });

  it("calls eventWithoutHandler when no handler matches", async () => {
    const nacked: boolean[] = [];

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Unknown",
          data: new TextEncoder().encode(JSON.stringify({})),
          headers: (() => {
            const map = new Map<string, string[]>();
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() {},
          nak() { nacked.push(true); },
          term() {},
        };
      },
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: vi.fn().mockResolvedValue(mockMessages),
        }),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: { add: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(true) },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never, jsm as never, "test-svc", registrations, silentLogger,
      undefined, undefined, undefined, undefined, undefined,
      metrics,
    );

    await vi.waitFor(() => {
      expect(nacked).toHaveLength(1);
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-svc", "Order.Unknown");
    expect(metrics.eventWithoutHandler).toHaveBeenCalledWith("test-svc", "Order.Unknown");
  });

  it("calls eventNotParsable on invalid JSON", async () => {
    const termed: boolean[] = [];

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode("not json{"),
          headers: (() => {
            const map = new Map<string, string[]>();
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() {},
          nak() {},
          term() { termed.push(true); },
        };
      },
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: vi.fn().mockResolvedValue(mockMessages),
        }),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: { add: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(true) },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never, jsm as never, "test-svc", registrations, silentLogger,
      undefined, undefined, undefined, undefined, undefined,
      metrics,
    );

    await vi.waitFor(() => {
      expect(termed).toHaveLength(1);
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-svc", "Order.Created");
    expect(metrics.eventNotParsable).toHaveBeenCalledWith("test-svc", "Order.Created");
  });

  it("applies routingKeyMapper", async () => {
    const acked: boolean[] = [];
    const mapper = (key: string) => key.replace(/\.\d+/, ".ID");

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.123",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
          headers: (() => {
            const map = new Map([
              ["ce-specversion", ["1.0"]],
              ["ce-type", ["Order.123"]],
              ["ce-source", ["test"]],
              ["ce-id", ["id-1"]],
              ["ce-time", ["2026-01-01T00:00:00Z"]],
            ]);
            return {
              get(k: string) { return map.get(k)?.[0] ?? ""; },
              has(k: string) { return map.has(k); },
              keys() { return [...map.keys()]; },
              [Symbol.iterator]() { return map.entries(); },
            };
          })(),
          ack() { acked.push(true); },
          nak() {},
          term() {},
        };
      },
    };

    const js = {
      consumers: {
        get: vi.fn().mockResolvedValue({
          consume: vi.fn().mockResolvedValue(mockMessages),
        }),
      },
    };

    const jsm = {
      streams: { add: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      consumers: { add: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue(true) },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.#",
        handler: async () => {},
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never, jsm as never, "test-svc", registrations, silentLogger,
      undefined, undefined, undefined, undefined, undefined,
      metrics, mapper,
    );

    await vi.waitFor(() => {
      expect(acked).toHaveLength(1);
    });

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-svc", "Order.ID");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-svc", "Order.ID", expect.any(Number),
    );
  });
});

describe("NATS Core Consumer Metrics", () => {
  let metrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    metrics = createMockMetrics();
    vi.clearAllMocks();
  });

  it("calls eventReceived and eventAck on successful handler", async () => {
    const { nc, subscriptions } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => {},
        requestReply: false,
      },
    ];

    startCoreConsumers(
      nc as never, "test-service", registrations, silentLogger,
      undefined, undefined, undefined, metrics,
    );

    const msg = createMockMsg({ orderId: "123" }, ceHeaders);
    await subscriptions[0].callback(null, msg);

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-service", "get-order");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-service", "get-order", expect.any(Number),
    );
  });

  it("calls eventNack on handler error", async () => {
    const { nc, subscriptions } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => { throw new Error("fail"); },
        requestReply: false,
      },
    ];

    startCoreConsumers(
      nc as never, "test-service", registrations, silentLogger,
      undefined, undefined, undefined, metrics,
    );

    const msg = createMockMsg({ orderId: "123" }, ceHeaders);
    await subscriptions[0].callback(null, msg);

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-service", "get-order");
    expect(metrics.eventNack).toHaveBeenCalledWith(
      "test-service", "get-order", expect.any(Number),
    );
  });

  it("calls eventNotParsable on invalid JSON", async () => {
    const { nc, subscriptions } = createMockNc();

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.test",
        routingKey: "test",
        handler: async () => {},
        requestReply: false,
      },
    ];

    startCoreConsumers(
      nc as never, "test-service", registrations, silentLogger,
      undefined, undefined, undefined, metrics,
    );

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

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-service", "test");
    expect(metrics.eventNotParsable).toHaveBeenCalledWith("test-service", "test");
  });

  it("applies routingKeyMapper", async () => {
    const { nc, subscriptions } = createMockNc();
    const mapper = (key: string) => key.replace(/-\d+/, "-ID");

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order-123",
        handler: async () => {},
        requestReply: false,
      },
    ];

    startCoreConsumers(
      nc as never, "test-service", registrations, silentLogger,
      undefined, undefined, undefined, metrics, mapper,
    );

    const msg = createMockMsg({ orderId: "123" }, ceHeaders);
    await subscriptions[0].callback(null, msg);

    expect(metrics.eventReceived).toHaveBeenCalledWith("test-service", "get-order-ID");
    expect(metrics.eventAck).toHaveBeenCalledWith(
      "test-service", "get-order-ID", expect.any(Number),
    );
  });
});

describe("NATS Publisher Metrics", () => {
  let metrics: ReturnType<typeof createMockMetrics>;

  beforeEach(() => {
    metrics = createMockMetrics();
    vi.clearAllMocks();
  });

  it("calls publishSucceed on successful publish", async () => {
    const publisher = new Publisher({
      serviceName: "test-service",
      stream: "events",
      metrics,
    });

    const mockJs = {
      publish: vi.fn(async () => ({ stream: "events", seq: 1 })),
    };

    publisher.wireJetStream(mockJs as never);
    await publisher.publish("order.created", { id: 1 });

    expect(metrics.publishSucceed).toHaveBeenCalledWith(
      "events", "order.created", expect.any(Number),
    );
    expect(metrics.publishFailed).not.toHaveBeenCalled();
  });

  it("calls publishFailed on publish error", async () => {
    const publisher = new Publisher({
      serviceName: "test-service",
      stream: "events",
      metrics,
    });

    const mockJs = {
      publish: vi.fn(async () => { throw new Error("publish failed"); }),
    };

    publisher.wireJetStream(mockJs as never);

    await expect(publisher.publish("order.created", { id: 1 })).rejects.toThrow("publish failed");

    expect(metrics.publishFailed).toHaveBeenCalledWith(
      "events", "order.created", expect.any(Number),
    );
    expect(metrics.publishSucceed).not.toHaveBeenCalled();
  });

  it("applies routingKeyMapper to publish metrics", async () => {
    const mapper = (key: string) => key.replace(/\.\d+/, ".ID");
    const publisher = new Publisher({
      serviceName: "test-service",
      stream: "events",
      metrics,
      routingKeyMapper: mapper,
    });

    const mockJs = {
      publish: vi.fn(async () => ({ stream: "events", seq: 1 })),
    };

    publisher.wireJetStream(mockJs as never);
    await publisher.publish("order.123", { id: 1 });

    expect(metrics.publishSucceed).toHaveBeenCalledWith(
      "events", "order.ID", expect.any(Number),
    );
  });

  it("replaces empty mapped routing key with 'unknown'", async () => {
    const mapper = () => "";
    const publisher = new Publisher({
      serviceName: "test-service",
      stream: "events",
      metrics,
      routingKeyMapper: mapper,
    });

    const mockJs = {
      publish: vi.fn(async () => ({ stream: "events", seq: 1 })),
    };

    publisher.wireJetStream(mockJs as never);
    await publisher.publish("order.created", { id: 1 });

    expect(metrics.publishSucceed).toHaveBeenCalledWith(
      "events", "unknown", expect.any(Number),
    );
  });
});
