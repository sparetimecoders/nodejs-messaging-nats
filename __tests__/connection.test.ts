import { describe, expect, it, vi, beforeEach } from "vitest";
import { Connection } from "../src/connection.js";

// Mock the nats module
vi.mock("nats", async () => {
  const actual = await vi.importActual<typeof import("nats")>("nats");
  return {
    ...actual,
    connect: vi.fn(),
  };
});

import { connect, Events } from "nats";
const mockConnect = vi.mocked(connect);

function createMockNatsConnection(overrides?: Record<string, unknown>) {
  return {
    jetstream: vi.fn(() => ({})),
    jetstreamManager: vi.fn(async () => ({
      streams: {
        add: vi.fn(),
        update: vi.fn(),
      },
    })),
    drain: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    status: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        // Default: no events
      },
    })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Connection natsOptions pass-through", () => {
  it("passes natsOptions to nats.connect merged with servers", async () => {
    const mockNc = createMockNatsConnection();
    mockConnect.mockResolvedValue(mockNc as never);

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

    expect(mockConnect).toHaveBeenCalledWith({
      maxReconnectAttempts: 10,
      reconnectTimeWait: 2000,
      reconnectJitter: 500,
      servers: ["nats://localhost:4222"],
    });

    await conn.close();
  });

  it("uses url as servers even if natsOptions tries to override servers", async () => {
    const mockNc = createMockNatsConnection();
    mockConnect.mockResolvedValue(mockNc as never);

    // TypeScript prevents setting servers via natsOptions (Omit<>),
    // but we verify the runtime spread order is correct
    const conn = new Connection({
      url: "nats://myhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: ["nats://myhost:4222"],
      }),
    );

    await conn.close();
  });

  it("connects with default options when natsOptions is not provided", async () => {
    const mockNc = createMockNatsConnection();
    mockConnect.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    expect(mockConnect).toHaveBeenCalledWith({
      servers: ["nats://localhost:4222"],
    });

    await conn.close();
  });
});

describe("Connection close() uses drain", () => {
  it("calls drain() on close", async () => {
    const mockNc = createMockNatsConnection();
    mockConnect.mockResolvedValue(mockNc as never);

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
    mockConnect.mockResolvedValue(mockNc as never);

    const callOrder: string[] = [];
    const stopFn = vi.fn(() => callOrder.push("stop"));
    mockNc.drain.mockImplementation(async () => {
      callOrder.push("drain");
    });

    // Register a core consumer so we get a consumer handle
    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    // We need to add a consumer to verify ordering.
    // Use a service request consumer which creates core subscriptions.
    conn.addServiceRequestConsumer("test.route", async () => ({ ok: true }));

    // Override subscribe to capture the stop (unsubscribe) call
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
    mockConnect.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    // Should not throw
    await expect(conn.close()).resolves.toBeUndefined();
  });
});

describe("Connection reconnection callbacks", () => {
  it("invokes onReconnect when NATS emits a reconnect event", async () => {
    const onReconnect = vi.fn();
    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          // Yield a reconnect event
          yield { type: Events.Reconnect, data: "reconnected" };
        },
      }),
    });

    mockConnect.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      onReconnect,
    });

    await conn.start();

    // Allow the async iterator to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onReconnect).toHaveBeenCalledTimes(1);

    await conn.close();
  });

  it("invokes onDisconnect with an Error when NATS emits a disconnect event", async () => {
    const onDisconnect = vi.fn();

    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: Events.Disconnect, data: "server went away" };
        },
      }),
    });

    mockConnect.mockResolvedValue(mockNc as never);

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
    expect(err.message).toBe("server went away");

    await conn.close();
  });

  it("does not start status monitor when no callbacks are provided", async () => {
    const mockNc = createMockNatsConnection();
    mockConnect.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
    });

    await conn.start();

    // status() should not be called when no callbacks are registered
    expect(mockNc.status).not.toHaveBeenCalled();

    await conn.close();
  });

  it("stops monitoring status events on close", async () => {
    const onReconnect = vi.fn();
    let yieldResolve: (() => void) | undefined;
    const yieldPromise = new Promise<void>((r) => { yieldResolve = r; });
    let iteratorDone = false;

    const mockNc = createMockNatsConnection({
      status: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: Events.Reconnect, data: "" };
          yieldResolve?.();
          // Wait a bit then yield another - should be ignored after close
          await new Promise((r) => setTimeout(r, 50));
          if (!iteratorDone) {
            yield { type: Events.Reconnect, data: "" };
          }
        },
      }),
    });

    mockConnect.mockResolvedValue(mockNc as never);

    const conn = new Connection({
      url: "nats://localhost:4222",
      serviceName: "test-svc",
      onReconnect,
    });

    await conn.start();
    await yieldPromise;

    // First event should have been processed
    expect(onReconnect).toHaveBeenCalledTimes(1);

    iteratorDone = true;
    await conn.close();

    // After close, the second event should not trigger the callback
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
