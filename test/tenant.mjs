/**
 * Tenant isolation check: two subscribers must not see each other's watches.
 *
 * The gateway identifies a caller with a credential header; we hash it into a
 * scope that prefixes every workspace key. This test drives the same server
 * with three identities and asserts the watch lists stay apart.
 *
 *   APIFY_TOKEN=... npm start &
 *   node test/tenant.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const header = process.env.TENANT_HEADER ?? "x-mcpize-user-id";

async function connect(headers) {
  const client = new Client({ name: "ad-radar-tenant", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : undefined),
  );
  return client;
}

function text(result) {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const alice = await connect({ [header]: "tenant-alice" });
const bob = await connect({ [header]: "tenant-bob" });
const anon = await connect(null);

const baseline = await alice.callTool({
  name: "watch_advertiser",
  arguments: { advertiser: "hoka", country: "US" },
});
console.log("\n--- alice baseline ---");
console.log(text(baseline).slice(0, 300));

const aliceList = text(await alice.callTool({ name: "list_watches", arguments: {} }));
const bobList = text(await bob.callTool({ name: "list_watches", arguments: {} }));
const anonList = text(await anon.callTool({ name: "list_watches", arguments: {} }));

console.log(`\n--- alice sees ---\n${aliceList.slice(0, 300)}`);
console.log(`\n--- bob sees ---\n${bobList.slice(0, 300)}`);
console.log(`\n--- no header sees ---\n${anonList.slice(0, 300)}`);

const checks = [
  ["alice sees her own watch", /hoka/i.test(aliceList)],
  ["bob does not see alice's watch", !/hoka/i.test(bobList)],
  ["anonymous caller is separate from alice", !/hoka/i.test(anonList)],
  ["baseline was a baseline", baseline.structuredContent?.baseline === true],
  ["reported workspace is the caller-chosen name", baseline.structuredContent?.workspace === "default"],
];

console.log("\n--- assertions ---");
let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) failed += 1;
}

await Promise.all([alice.close(), bob.close(), anon.close()]);
process.exit(failed ? 1 : 0);
