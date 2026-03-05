import { describe, expect, it, vi, beforeEach } from "vitest";
import { startJSConsumers } from "../src/consumer.js";
import type { JSConsumerRegistration } from "../src/consumer.js";
import type { ConsumerDefaults } from "../src/connection.js";
import { AckPolicy } from "nats";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

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
      add: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(true),
    },
  };

  return { js, jsm, mockConsumer, mockMessages };
}

describe("Consumer defaults (connection-level)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies maxDeliver from consumerDefaults", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { maxDeliver: 5 };

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
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
      undefined,
      undefined,
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 5,
    });
  });

  it("applies backOff from consumerDefaults (converted to nanoseconds)", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = {
      backOff: [1000, 5000, 30_000],
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
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
      undefined,
      undefined,
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      backoff: [1_000_000_000, 5_000_000_000, 30_000_000_000],
    });
  });

  it("applies both maxDeliver and backOff from consumerDefaults", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = {
      maxDeliver: 4,
      backOff: [1000, 2000, 5000],
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Ping",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 4,
      backoff: [1_000_000_000, 2_000_000_000, 5_000_000_000],
    });
  });

  it("does not set max_deliver or backoff when consumerDefaults is undefined", async () => {
    const { js, jsm } = createMockJsAndJsm();

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
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
    });
  });

  it("does not set max_deliver when consumerDefaults.maxDeliver is 0", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { maxDeliver: 0 };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Ping",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
    });
  });

  it("does not set backoff when consumerDefaults.backOff is empty", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { backOff: [] };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Ping",
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Ping",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
    });
  });
});

describe("Per-consumer options override defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("per-consumer maxDeliver overrides connection default", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { maxDeliver: 5 };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
        maxDeliver: 10,
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 10,
    });
  });

  it("per-consumer backOff overrides connection default", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { backOff: [1000, 2000] };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
        backOff: [500, 1000, 5000],
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      backoff: [500_000_000, 1_000_000_000, 5_000_000_000],
    });
  });

  it("per-consumer options work without connection defaults", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
        maxDeliver: 3,
        backOff: [2000, 10_000],
      },
    ];

    await startJSConsumers(
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Order.Created",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 3,
      backoff: [2_000_000_000, 10_000_000_000],
    });
  });

  it("uses first registration options for grouped consumers", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const defaults: ConsumerDefaults = { maxDeliver: 5 };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
        maxDeliver: 8,
      },
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Updated",
        handler: async () => {},
        durable: "test-svc",
        // This second registration's maxDeliver is ignored (first wins)
        maxDeliver: 3,
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
      defaults,
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subjects: ["events.Order.Created", "events.Order.Updated"],
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 8,
    });
  });
});
