import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { Connection } from "../src/connection.js";
import type { Endpoint } from "@sparetimecoders/messaging";

const fixturesPath = resolve(
  import.meta.dirname,
  "../testdata/topology.json",
);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8"));

const noopHandler = async () => {};

interface Setup {
  pattern: string;
  direction: string;
  routingKey?: string;
  exchange?: string;
  targetService?: string;
  ephemeral?: boolean;
  destinationQueue?: string;
}

function applySetup(conn: Connection, setup: Setup): "skip" | void {
  switch (`${setup.pattern}:${setup.direction}`) {
    case "event-stream:publish":
      conn.addEventPublisher();
      break;
    case "event-stream:consume":
      conn.addEventConsumer(setup.routingKey!, noopHandler, {
        ephemeral: setup.ephemeral,
      });
      break;
    case "custom-stream:publish":
      conn.addCustomStreamPublisher(setup.exchange!);
      break;
    case "custom-stream:consume":
      conn.addCustomStreamConsumer(
        setup.exchange!,
        setup.routingKey!,
        noopHandler,
      );
      break;
    case "service-request:consume":
      conn.addServiceRequestConsumer(setup.routingKey!, noopHandler);
      break;
    case "service-request:publish":
      conn.addServiceRequestPublisher(setup.targetService!);
      break;
    case "service-response:consume":
      conn.addServiceResponseConsumer(
        setup.targetService!,
        setup.routingKey!,
        noopHandler,
      );
      break;
    case "queue-publish:publish":
      // queue-publish not yet implemented for NATS; skip handled at scenario level.
      return "skip";
    default:
      throw new Error(
        `Unknown setup: ${setup.pattern}:${setup.direction}`,
      );
  }
}

function assertEndpoint(
  actual: Endpoint,
  expected: Endpoint,
): void {
  expect(actual.direction).toBe(expected.direction);
  expect(actual.pattern).toBe(expected.pattern);
  expect(actual.exchangeName).toBe(expected.exchangeName);
  expect(actual.exchangeKind).toBe(expected.exchangeKind);
  if (expected.routingKey) {
    expect(actual.routingKey).toBe(expected.routingKey);
  }
  if (expected.ephemeral) {
    expect(actual.ephemeral).toBe(true);
    expect(actual.queueName).toBeUndefined();
  } else if (expected.queueName) {
    expect(actual.queueName).toBe(expected.queueName);
  }
}

describe("NATS topology conformance", () => {
  for (const scenario of fixtures.scenarios) {
    const expectedEndpoints = scenario.expectedEndpoints?.nats;
    if (!expectedEndpoints) continue;

    it(scenario.name, () => {
      const conn = new Connection({
        url: "nats://localhost:4222",
        serviceName: scenario.serviceName,
      });

      let skip = false;
      for (const setup of scenario.setups as Setup[]) {
        if (applySetup(conn, setup) === "skip") {
          skip = true;
        }
      }
      if (skip) return;

      const topology = conn.topology();
      expect(topology.transport).toBe("nats");
      expect(topology.serviceName).toBe(scenario.serviceName);
      expect(topology.endpoints).toHaveLength(expectedEndpoints.length);

      for (let i = 0; i < expectedEndpoints.length; i++) {
        assertEndpoint(topology.endpoints[i], expectedEndpoints[i]);
      }
    });
  }
});
