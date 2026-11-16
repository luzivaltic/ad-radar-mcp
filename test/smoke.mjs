/**
 * End-to-end smoke test: starts nothing, expects the server on MCP_URL.
 * Exercises every tool through the MCP protocol against the live Actor.
 *
 *   APIFY_TOKEN=... npm start &
 *   node test/smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const workspace = `smoke-${Date.now()}`;

function show(label, result) {
  const text = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(`\n=== ${label} ${result.isError ? "(ERROR)" : ""} ===`);
  console.log(text.slice(0, 1400));
  if (!result.isError && result.structuredContent) {
    const keys = Object.keys(result.structuredContent);
    console.log(`[structured: ${keys.join(", ")}]`);
  }
  return result;
}

const client = new Client({ name: "ad-radar-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const listed = await client.listTools();
console.log("tools:", listed.tools.map((t) => t.name).join(", "));
for (const t of listed.tools) {
  console.log(`- ${t.name}: ${t.description.slice(0, 90)}…`);
}

const search = show(
  "search_ads",
  await client.callTool({
    name: "search_ads",
    arguments: { query: "running shoes", limit: 5, country: "US", workspace },
  }),
);

show(
  "search_google_ads",
  await client.callTool({
    name: "search_google_ads",
    arguments: { query: "nike.com", region: "US", limit: 5, workspace },
  }),
);

show(
  "advertiser_ads",
  await client.callTool({
    name: "advertiser_ads",
    arguments: { advertiser: "nike", limit: 5, country: "US", workspace },
  }),
);

const first = show(
  "watch_advertiser (baseline)",
  await client.callTool({
    name: "watch_advertiser",
    arguments: { advertiser: "nike", country: "US", workspace },
  }),
);

show(
  "watch_advertiser (second check)",
  await client.callTool({
    name: "watch_advertiser",
    arguments: { advertiser: "nike", country: "US", workspace },
  }),
);

show(
  "list_watches",
  await client.callTool({ name: "list_watches", arguments: { workspace } }),
);

const ads = search.structuredContent?.ads ?? [];
console.log("\n--- assertions ---");
const checks = [
  ["search returned ads", ads.length > 0],
  ["ads carry advertiser names", ads.every((a) => typeof a.advertiser === "string" && a.advertiser.length > 0)],
  ["ads carry a library url", ads.every((a) => typeof a.url === "string" && a.url.includes("ads/library"))],
  ["ads carry days_running", ads.some((a) => typeof a.days_running === "number")],
  ["baseline saved a snapshot", Boolean(first.structuredContent?.baseline)],
];
let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) failed += 1;
}
await client.close();
process.exit(failed ? 1 : 0);
