import { describe, expect, it, mock, beforeEach } from "bun:test";
import { startJSConsumers } from "../src/consumer.js";
import type { JSConsumerRegistration } from "../src/consumer.js";
import type { ConsumerDefaults } from "../src/connection.js";
import type { JSConsumerOptions } from "../src/consumer.js";
import { AckPolicy, NatsError } from "nats";

const silentLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};

function createMockJsAndJsm() {
  const mockMessages = {
    stop: mock(() => {}),
    [Symbol.asyncIterator]: async function* () {
      // no messages in test
    },
  };

  const mockConsumer = {
    consume: mock(() => Promise.resolve(mockMessages)),
  };

  const js = {
    consumers: {
      get: mock(() => Promise.resolve(mockConsumer)),
    },
  };

  const jsm = {
    streams: {
      add: mock(() => Promise.resolve({})),
      update: mock(() => Promise.resolve({})),
    },
    consumers: {
      add: mock(() => Promise.resolve({})),
      delete: mock(() => Promise.resolve(true)),
    },
  };

  return { js, jsm, mockConsumer, mockMessages };
}

describe("Consumer defaults (connection-level)", () => {
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
      { consumerDefaults: defaults },
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
      { consumerDefaults: defaults },
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
      { consumerDefaults: defaults },
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
      { consumerDefaults: defaults },
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
      { consumerDefaults: defaults },
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subject: "events.Ping",
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
    });
  });
});

describe("Per-consumer options override defaults", () => {
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
      { consumerDefaults: defaults },
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
      { consumerDefaults: defaults },
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
        maxDeliver: 3,
      },
    ];

    await startJSConsumers(
      js as never,
      jsm as never,
      "test-svc",
      registrations,
      silentLogger,
      { consumerDefaults: defaults },
    );

    expect(jsm.consumers.add).toHaveBeenCalledWith("events", {
      filter_subjects: ["events.Order.Created", "events.Order.Updated"],
      ack_policy: AckPolicy.Explicit,
      durable_name: "test-svc",
      max_deliver: 8,
    });
  });
});

describe("Stream error handling", () => {
  it("rethrows non-NATS errors from stream update", async () => {
    const { js } = createMockJsAndJsm();

    // streams.add fails, then streams.update also fails with a non-NATS error
    const jsm = {
      streams: {
        add: mock(() => Promise.reject(new Error("add failed"))),
        update: mock(() => Promise.reject(new Error("network timeout"))),
      },
      consumers: {
        add: mock(() => Promise.resolve({})),
        delete: mock(() => Promise.resolve(true)),
      },
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

    await expect(
      startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger),
    ).rejects.toThrow("network timeout");
  });

  it("suppresses NATS 10058 error (stream already exists)", async () => {
    const { js } = createMockJsAndJsm();

    const natsErr = new NatsError("stream exists", "10058", new Error("inner"));
    (natsErr as any).api_error = { err_code: 10058 };
    const jsm = {
      streams: {
        add: mock(() => Promise.reject(new Error("add failed"))),
        update: mock(() => Promise.reject(natsErr)),
      },
      consumers: {
        add: mock(() => Promise.resolve({ name: "test-svc" })),
        delete: mock(() => Promise.resolve(true)),
      },
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

    // Should not throw
    await startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger);
    expect(jsm.consumers.add).toHaveBeenCalled();
  });
});

describe("backOff/maxDeliver validation", () => {
  it("throws when backOff length exceeds maxDeliver", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "test-svc",
        maxDeliver: 2,
        backOff: [1000, 5000, 30000],
      },
    ];

    await expect(
      startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger),
    ).rejects.toThrow("backOff length (3) exceeds maxDeliver (2)");
  });
});

describe("Ephemeral consumer error handling", () => {
  it("rethrows error when ephemeral consumer creation fails", async () => {
    const { js } = createMockJsAndJsm();

    const jsm = {
      streams: {
        add: mock(() => Promise.resolve({})),
        update: mock(() => Promise.resolve({})),
      },
      consumers: {
        add: mock(() => Promise.reject(new Error("consumer creation failed"))),
        delete: mock(() => Promise.resolve(true)),
      },
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        // no durable = ephemeral
      },
    ];

    await expect(
      startJSConsumers(js as never, jsm as never, "test-svc", registrations, silentLogger),
    ).rejects.toThrow("consumer creation failed");
  });
});
