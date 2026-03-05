// MIT License
// Copyright (c) 2026 sparetimecoders

import type {
  Context,
  TextMapPropagator,
} from "@opentelemetry/api";
import {
  context as otelContext,
  propagation,
} from "@opentelemetry/api";
import type { MsgHdrs } from "nats";

function propagatorOrGlobal(p?: TextMapPropagator): TextMapPropagator {
  return p ?? propagation;
}

/**
 * Inject trace context from the given OTel context into NATS headers.
 * Mirrors golang/nats/tracing.go injectToHeaders.
 */
export function injectToHeaders(
  ctx: Context,
  headers: MsgHdrs,
  p?: TextMapPropagator,
): MsgHdrs {
  const carrier: Record<string, string> = {};
  propagatorOrGlobal(p).inject(ctx, carrier, {
    set(c: Record<string, string>, key: string, value: string) {
      c[key] = value;
    },
  });
  for (const [k, v] of Object.entries(carrier)) {
    headers.set(k, v);
  }
  return headers;
}

/**
 * Extract trace context from NATS headers into an OTel context.
 * Mirrors golang/nats/tracing.go extractToContext.
 */
export function extractToContext(
  headers: MsgHdrs,
  p?: TextMapPropagator,
): Context {
  const carrier: Record<string, string> = {};
  for (const [k] of headers) {
    carrier[k] = headers.get(k);
  }
  return propagatorOrGlobal(p).extract(otelContext.active(), carrier, {
    get(c, key) {
      return c[key] ?? "";
    },
    keys(c) {
      return Object.keys(c);
    },
  });
}
