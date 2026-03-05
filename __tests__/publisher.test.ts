import { describe, expect, it, vi } from "vitest";
import { Publisher } from "../src/publisher.js";
import {
  CESpecVersion,
  CESpecVersionValue,
  CEType,
  CESource,
  CEDataContentType,
  CETime,
  CEID,
} from "@gomessaging/spec";

describe("Publisher", () => {
  describe("JetStream publish", () => {
    it("publishes JSON-encoded message with CE headers", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "events",
      });

      let capturedSubject = "";
      let capturedData: Uint8Array = new Uint8Array();
      let capturedHeaders: Map<string, string[]> | null = null;

      // Mock JetStream client
      const mockJs = {
        publish: vi.fn(async (subject: string, data: Uint8Array, opts: { headers: unknown }) => {
          capturedSubject = subject;
          capturedData = data;
          capturedHeaders = opts.headers as Map<string, string[]>;
          return { stream: "events", seq: 1 };
        }),
      };

      publisher.wireJetStream(mockJs as never);

      await publisher.publish("order.created", { orderId: "123" });

      expect(capturedSubject).toBe("events.order.created");

      const body = JSON.parse(new TextDecoder().decode(capturedData));
      expect(body).toEqual({ orderId: "123" });

      expect(mockJs.publish).toHaveBeenCalledOnce();

      // Verify headers were passed (the nats headers object)
      const hdrs = capturedHeaders as unknown as { get(k: string): string; has(k: string): boolean };
      expect(hdrs.get(CESpecVersion)).toBe(CESpecVersionValue);
      expect(hdrs.get(CEType)).toBe("order.created");
      expect(hdrs.get(CESource)).toBe("test-service");
      expect(hdrs.get(CEDataContentType)).toBe("application/json");
      expect(hdrs.get(CETime)).toBeTruthy();
      expect(hdrs.get(CEID)).toBeTruthy();
      expect(hdrs.get("service")).toBe("test-service");
    });

    it("generates a valid RFC3339 timestamp", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "events",
      });

      let capturedHeaders: unknown = null;
      const mockJs = {
        publish: vi.fn(async (_subject: string, _data: Uint8Array, opts: { headers: unknown }) => {
          capturedHeaders = opts.headers;
          return { stream: "events", seq: 1 };
        }),
      };
      publisher.wireJetStream(mockJs as never);

      await publisher.publish("test.event", { data: true });

      const hdrs = capturedHeaders as { get(k: string): string };
      const timeValue = hdrs.get(CETime);
      // Should be a valid ISO 8601 / RFC 3339 timestamp
      expect(new Date(timeValue).toISOString()).toBeTruthy();
    });

    it("generates a UUID for ce-id", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "events",
      });

      let capturedHeaders: unknown = null;
      const mockJs = {
        publish: vi.fn(async (_subject: string, _data: Uint8Array, opts: { headers: unknown }) => {
          capturedHeaders = opts.headers;
          return { stream: "events", seq: 1 };
        }),
      };
      publisher.wireJetStream(mockJs as never);

      await publisher.publish("test.event", {});

      const hdrs = capturedHeaders as { get(k: string): string };
      const id = hdrs.get(CEID);
      // UUID v4 format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("Core request-reply publish", () => {
    it("uses request() for Core NATS publishing", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "order-service",
      });

      const mockNc = {
        request: vi.fn(async () => {
          return { data: new Uint8Array() };
        }),
      };

      publisher.wireCoreRequest(mockNc as never, 5000);

      await publisher.publish("get-order", { orderId: "456" });

      expect(mockNc.request).toHaveBeenCalledOnce();
      const args = mockNc.request.mock.calls[0] as unknown as [string, Uint8Array, { timeout: number; headers: unknown }];
      expect(args[0]).toBe("order-service.get-order");
      expect(JSON.parse(new TextDecoder().decode(args[1]))).toEqual({ orderId: "456" });
      expect(args[2].timeout).toBe(5000);
    });

    it("uses default 30s timeout when not specified", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "order-service",
      });

      const mockNc = {
        request: vi.fn(async () => {
          return { data: new Uint8Array() };
        }),
      };

      publisher.wireCoreRequest(mockNc as never);

      await publisher.publish("get-order", { orderId: "456" });

      const args = mockNc.request.mock.calls[0] as unknown as [string, Uint8Array, { timeout: number; headers: unknown }];
      expect(args[2].timeout).toBe(30_000);
    });
  });

  describe("subject naming", () => {
    it("builds subject as stream.routingKey", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "custom-stream",
      });

      let capturedSubject = "";
      const mockJs = {
        publish: vi.fn(async (subject: string) => {
          capturedSubject = subject;
          return { stream: "custom-stream", seq: 1 };
        }),
      };
      publisher.wireJetStream(mockJs as never);

      await publisher.publish("user.updated", { userId: "789" });

      expect(capturedSubject).toBe("custom-stream.user.updated");
    });
  });

  describe("error handling", () => {
    it("throws if publish called before wiring", async () => {
      const publisher = new Publisher({
        serviceName: "test-service",
        stream: "events",
      });

      await expect(
        publisher.publish("test.event", {}),
      ).rejects.toThrow("Publisher not wired");
    });
  });
});
