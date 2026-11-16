/**
 * Ad Radar — competitor ad intelligence for AI agents.
 *
 * One MCP server, four tools, backed by the Meta Ad Library scraper. Runs
 * stateless behind MCPize's proxy: every request gets its own server and
 * transport, while watch state lives in an Apify key-value store.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { hasApifyToken } from "./apify.js";
import { registerTools } from "./tools.js";
import { resolveTenant, type Tenant } from "./tenant.js";

const PORT = Number(process.env.PORT ?? "3000");

const INSTRUCTIONS = [
  "Ad Radar answers questions about live Facebook and Instagram advertising.",
  "",
  "Use search_ads to find who is advertising around a keyword and what their ads say.",
  "Use search_google_ads to see which advertisers Google shows ads for a website or brand.",
  "Use advertiser_ads to audit one company's current creative.",
  "Use watch_advertiser to save a baseline and later get only what changed (new ads, stopped ads, rewritten copy).",
  "Use list_watches to see what is already being monitored.",
  "",
  "Ad copy, landing pages and run length are real values from the Meta Ad Library, not samples.",
].join("\n");

function buildServer(tenant: Tenant): McpServer {
  const server = new McpServer(
    { name: "ad-radar", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, tenant);
  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "ad-radar",
    tools: ["search_ads", "search_google_ads", "advertiser_ads", "watch_advertiser", "list_watches"],
    apify_configured: hasApifyToken(),
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Ad Radar",
    mcp_endpoint: "/mcp",
    transport: "streamable-http",
    legacy_sse: "/sse",
  });
});

let tenantLogged = false;

const mcpPost = async (req: Request, res: Response) => {
  const tenant = resolveTenant(req.headers);
  if (!tenantLogged) {
    tenantLogged = true;
    console.log(`[tenant] ${tenant.scope} via ${tenant.source}`);
  }
  const server = buildServer(tenant);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
        id: null,
      });
    }
  }
};

app.post("/mcp", mcpPost);
app.post("/", mcpPost);

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "This server is stateless. POST JSON-RPC to /mcp, or use /sse for the legacy transport." },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "No sessions to delete." }, id: null });
});

/* Legacy SSE transport, kept for clients that have not moved to streamable HTTP. */
const sseSessions = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  const server = buildServer(resolveTenant(req.headers));
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, transport);
  res.on("close", () => {
    sseSessions.delete(transport.sessionId);
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? "");
  const transport = sseSessions.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "Unknown or expired SSE session." });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", mcp_endpoint: "/mcp" });
});

app.listen(PORT, () => {
  console.log(`ad-radar listening on :${PORT} (mcp: /mcp, sse: /sse, health: /health)`);
  if (!hasApifyToken()) console.warn("APIFY_TOKEN is not set — tool calls will fail.");
});
