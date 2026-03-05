import { describe, expect, it, vi, beforeEach } from "vitest";
import { startJSConsumers, startCoreConsumers } from "../src/consumer.js";
import type { JSConsumerRegistration, CoreConsumerRegistration } from "../src/consumer.js";
import type { Notification, ErrorNotification } from "@gomessaging/spec";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createCEHeaders() {
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
}

describe("JetStream notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits notification on successful handler", async () => {
    const notifications: Notification[] = [];
    const onNotification = vi.fn((n: Notification) => notifications.push(n));

    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "999" })),
          headers: createCEHeaders(),
          ack: vi.fn(),
          nak: vi.fn(),
          term: vi.fn(),
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
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
      undefined,
      undefined,
      undefined,
      onNotification,
    );

    await vi.waitFor(() => {
      expect(onNotification).toHaveBeenCalledOnce();
    });

    const n = notifications[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.deliveryInfo.key).toBe("Order.Created");
    expect(n.deliveryInfo.source).toBe("events");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits error notification on handler failure", async () => {
    const errors: ErrorNotification[] = [];
    const onError = vi.fn((n: ErrorNotification) => errors.push(n));
    const handlerError = new Error("boom");

    const nakFn = vi.fn();
    const mockMessages = {
      stop: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          subject: "events.Order.Created",
          data: new TextEncoder().encode(JSON.stringify({ orderId: "999" })),
          headers: createCEHeaders(),
          ack: vi.fn(),
          nak: nakFn,
          term: vi.fn(),
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
        handler: async () => { throw handlerError; },
        durable: "test-svc",
      },
    ];

    await startJSConsumers(
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      onError,
    );

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });

    const n = errors[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.error).toBe(handlerError);
    expect(n.deliveryInfo.key).toBe("Order.Created");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
    expect(nakFn).toHaveBeenCalled();
  });
});

describe("Core NATS notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  function createMockMsg(data: unknown) {
    const hdrs = new Map<string, string[]>([
      ["ce-specversion", ["1.0"]],
      ["ce-type", ["get-order"]],
      ["ce-source", ["client"]],
      ["ce-id", ["test-id"]],
      ["ce-time", ["2026-01-01T00:00:00Z"]],
    ]);
    return {
      subject: "svc.request.get-order",
      data: new TextEncoder().encode(JSON.stringify(data)),
      headers: {
        get(k: string) { return hdrs.get(k)?.[0] ?? ""; },
        has(k: string) { return hdrs.has(k); },
        keys() { return [...hdrs.keys()]; },
        [Symbol.iterator]() { return hdrs.entries(); },
      },
      reply: "",
      respond: vi.fn(),
    };
  }

  it("emits notification on successful Core handler", async () => {
    const { nc, subscriptions } = createMockNc();
    const notifications: Notification[] = [];
    const onNotification = vi.fn((n: Notification) => notifications.push(n));

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
      nc as never,
      "test-service",
      registrations,
      silentLogger,
      undefined,
      onNotification,
    );

    const msg = createMockMsg({ orderId: "123" });
    await subscriptions[0].callback(null, msg);

    expect(onNotification).toHaveBeenCalledOnce();
    const n = notifications[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.deliveryInfo.key).toBe("get-order");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits error notification on Core handler failure", async () => {
    const { nc, subscriptions } = createMockNc();
    const errors: ErrorNotification[] = [];
    const onError = vi.fn((n: ErrorNotification) => errors.push(n));
    const handlerError = new Error("core boom");

    const registrations: CoreConsumerRegistration<unknown, unknown>[] = [
      {
        kind: "core",
        subject: "svc.request.get-order",
        routingKey: "get-order",
        handler: async () => { throw handlerError; },
        requestReply: false,
      },
    ];

    startCoreConsumers(
      nc as never,
      "test-service",
      registrations,
      silentLogger,
      undefined,
      undefined,
      onError,
    );

    const msg = createMockMsg({ orderId: "123" });
    await subscriptions[0].callback(null, msg);

    expect(onError).toHaveBeenCalledOnce();
    const n = errors[0];
    expect(n.source).toBe("CONSUMER");
    expect(n.error).toBe(handlerError);
    expect(n.deliveryInfo.key).toBe("get-order");
    expect(n.durationMs).toBeGreaterThanOrEqual(0);
  });
});
