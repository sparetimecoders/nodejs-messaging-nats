import { describe, expect, it, vi, beforeEach } from "vitest";
import { startJSConsumers } from "../src/consumer.js";
import type { JSConsumerRegistration } from "../src/consumer.js";
import type { StreamConfigResolver } from "../src/connection.js";
import { DefaultStreamConfig } from "../src/connection.js";
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

describe("DefaultStreamConfig", () => {
  it("has 7-day max age in nanoseconds", () => {
    expect(DefaultStreamConfig.maxAge).toBe(7 * 24 * 60 * 60 * 1e9);
  });

  it("has 1 GiB max bytes", () => {
    expect(DefaultStreamConfig.maxBytes).toBe(1_073_741_824);
  });

  it("has 1 million max messages", () => {
    expect(DefaultStreamConfig.maxMsgs).toBe(1_000_000);
  });
});

describe("Stream config in startJSConsumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes stream config to jsm.streams.add when resolver is provided", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const resolver: StreamConfigResolver = () => ({
      max_age: 604_800_000_000_000,
      max_bytes: 1_073_741_824,
      max_msgs: 1_000_000,
    });

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
      resolver,
    );

    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "events",
      subjects: ["events.>"],
      max_age: 604_800_000_000_000,
      max_bytes: 1_073_741_824,
      max_msgs: 1_000_000,
    });
  });

  it("creates stream without retention limits when no resolver is provided", async () => {
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

    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "events",
      subjects: ["events.>"],
    });
  });

  it("passes stream config to jsm.streams.update on fallback", async () => {
    const { js, jsm } = createMockJsAndJsm();
    jsm.streams.add.mockRejectedValueOnce(new Error("stream already exists"));

    const resolver: StreamConfigResolver = () => ({
      max_age: 86_400_000_000_000,
      max_bytes: 512_000_000,
    });

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
      resolver,
    );

    expect(jsm.streams.update).toHaveBeenCalledWith("events", {
      subjects: ["events.>"],
      max_age: 86_400_000_000_000,
      max_bytes: 512_000_000,
    });
  });

  it("resolver receives correct stream name per group", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const resolvedStreams: string[] = [];
    const resolver: StreamConfigResolver = (stream) => {
      resolvedStreams.push(stream);
      if (stream === "custom") {
        return { max_msgs: 500_000 };
      }
      return { max_msgs: 1_000_000 };
    };

    const registrations: JSConsumerRegistration<unknown>[] = [
      {
        kind: "jetstream",
        stream: "events",
        routingKey: "Order.Created",
        handler: async () => {},
        durable: "svc",
      },
      {
        kind: "jetstream",
        stream: "custom",
        routingKey: "Alert",
        handler: async () => {},
        durable: "svc",
      },
    ];

    await startJSConsumers(
      js as never,
      jsm as never,
      "svc",
      registrations,
      silentLogger,
      undefined,
      resolver,
    );

    expect(resolvedStreams).toEqual(["events", "custom"]);

    expect(jsm.streams.add).toHaveBeenCalledTimes(2);
    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "events",
      subjects: ["events.>"],
      max_msgs: 1_000_000,
    });
    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "custom",
      subjects: ["custom.>"],
      max_msgs: 500_000,
    });
  });

  it("resolver returning empty object adds no retention limits", async () => {
    const { js, jsm } = createMockJsAndJsm();

    const resolver: StreamConfigResolver = () => ({});

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
      resolver,
    );

    expect(jsm.streams.add).toHaveBeenCalledWith({
      name: "events",
      subjects: ["events.>"],
    });
  });
});
