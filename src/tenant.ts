/**
 * Per-subscriber isolation.
 *
 * MCPize's gateway authenticates each subscriber before forwarding a request,
 * so the credential header identifies who is calling. We never store it: it is
 * hashed once into a short scope that prefixes every workspace key, which keeps
 * one subscriber's watches out of another's.
 *
 * If no credential header is present (local runs, our own CLI), every caller
 * shares the "public" scope.
 */

import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const HEADERS = [
  "x-mcpize-user-id",
  "x-mcpize-subscriber",
  "x-user-id",
  "x-api-key",
  "authorization",
];

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() ? value.trim() : null;
}

export type Tenant = { scope: string; source: string };

export function resolveTenant(headers: IncomingHttpHeaders): Tenant {
  for (const name of HEADERS) {
    const value = headerValue(headers, name);
    if (!value) continue;
    const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
    return { scope: `u${digest}`, source: name };
  }
  return { scope: "public", source: "none" };
}

/** Combines the subscriber scope with the caller-chosen workspace name. */
export function scopedWorkspace(tenant: Tenant, workspace: string | undefined): string {
  const ws = (workspace ?? "default").trim() || "default";
  return tenant.scope === "public" ? ws : `${tenant.scope}.${ws}`;
}
