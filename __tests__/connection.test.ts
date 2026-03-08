import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Events } from "nats";

// Module mock must be set up before importing the module that uses it
const mockConnectFn = mock(() => Promise.resolve({}));

mock.module("nats", () => {
  const actual = require("nats");
  return {
    ...actual,
    connect: mockConnectFn,
  };
});

import { Connection } from "../src/connection.js";

function createMockNatsConnection(overrides?: Record<string, unknown>) {
  return {
    jetstream: mock(() => ({})),
    jetstreamManager: mock(async () => ({
      streams: {
        add: mock(() => {}),
        update: mock(() => {}),
      },
    })),
    drain: mock(async () => {}),
    close: mock(async () => {}),
    flush: mock(async () => {}),
    subscribe: mock(() => ({ unsubscribe: mock(() => {}) })),
    status: mock(() => ({
      async *[Symbol.asyncIterator]() {
        // Default: no events
      },
    })),
    ...overrides,
  };
}

beforeEach(() => {
  mockConnectFn.mockReset();
});

describe("Connection natsOptions pass-through", () => {
  it("passes natsOptions to nats.connect merged with servers", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      natsOptions: {
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        reconnectJitter: 500,
      },
    });

    await conn.start();

    expect(mockConnectFn).toHaveBeenCalledWith({
      maxReconnectAttempts: 10,
      reconnectTimeWait: 2000,
      reconnectJitter: 500,
      servers: ["nats://localhost:4222"],
    });

    await conn.close();
  });

  it("uses url as servers even if natsOptions tries to override servers", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://myhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    expect(mockConnectFn).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: ["nats://myhost:4222"],
      }),
    );

    await conn.close();
  });

  it("connects with default options when natsOptions is not provided", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    expect(mockConnectFn).toHaveBeenCalledWith({
      servers: ["nats://localhost:4222"],
    });

    await conn.close();
  });
});

describe("Connection close() uses drain", () => {
  it("calls drain() on close", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();
    await conn.close();

    expect(mockNc.drain).toHaveBeenCalledTimes(1);
  });

  it("stops consumer handles before draining", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const callOrder: string[] = [];
    const stopFn = mock(() => { callOrder.push("stop"); });
    mockNc.drain.mockImplementation(async () => {
      callOrder.push("drain");
    });

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    conn.addServiceRequestConsumer("test.route", async () => ({ ok: true }));

    mockNc.subscribe.mockReturnValue({
      unsubscribe: stopFn,
    });

    await conn.start();
    await conn.close();

    expect(callOrder).toEqual(["stop", "drain"]);
  });

  it("handles drain() throwing when already closed", async () => {
    const mockNc = createMockNatsConnection();
    mockNc.drain.mockRejectedValue(new Error("connection already closed"));
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    await expect(conn.close()).resolves.toBeUndefined();
  });
});

describe("Connection reconnection callbacks", () => {
  it("invokes onReconnect when NATS emits a reconnect event", async () => {
    const onReconnect = mock(() => {});
    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: Events.Reconnect, data: "reconnected" };
        },
      }),
    });

    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      onReconnect,
    });

    await conn.start();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onReconnect).toHaveBeenCalledTimes(1);

    await conn.close();
  });

  it("invokes onDisconnect with an Error when NATS emits a disconnect event", async () => {
    const onDisconnect = mock(() => {});

    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: Events.Disconnect, data: "server went away" };
        },
      }),
    });

    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      onDisconnect,
    });

    await conn.start();

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    const err = onDisconnect.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("server went away");

    await conn.close();
  });

  it("does not start status monitor when no callbacks are provided", async () => {
    const mockNc = createMockNatsConnection();
    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    expect(mockNc.status).not.toHaveBeenCalled();

    await conn.close();
  });

  it("stops monitoring status events on close", async () => {
    const onReconnect = mock(() => {});
    let yieldResolve: (() => void) | undefined;
    const yieldPromise = new Promise<void>((r) => { yieldResolve = r; });
    let iteratorDone = false;

    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: Events.Reconnect, data: "" };
          yieldResolve?.();
          await new Promise((r) => setTimeout(r, 50));
          if (!iteratorDone) {
            yield { type: Events.Reconnect, data: "" };
          }
        },
      }),
    });

    mockConnectFn.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      onReconnect,
    });

    await conn.start();
    await yieldPromise;

    expect(onReconnect).toHaveBeenCalledTimes(1);

    iteratorDone = true;
    await conn.close();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
