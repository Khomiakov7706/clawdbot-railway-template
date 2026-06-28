// HTTP entrypoint. Serves:
//   GET  /health   - liveness/readiness probe (no auth)
//   GET  /version  - build info (no auth)
//   POST /mcp      - MCP over streamable-http (bearer-auth, stateless)
//
// OpenClaw connects with:
//   openclaw mcp add scrum --transport streamable-http \
//     --url http://scrum-service.railway.internal:${PORT}/mcp \
//     --header "Authorization=Bearer ${INTERNAL_API_KEY}"
import crypto from "node:crypto";

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer, VERSION } from "./mcp.mjs";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.trim();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "scrum-service", version: VERSION });
});

app.get("/version", (_req, res) => {
  res.json({ service: "scrum-service", version: VERSION, node: process.version });
});

// Constant-time bearer check so internal calls can't be spoofed from the public net.
function authorized(req) {
  if (!INTERNAL_API_KEY) return false; // fail closed: refuse if no key is configured
  const header = req.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(INTERNAL_API_KEY);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

app.post("/mcp", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Stateless: a new server + transport per request, disposed when the response closes.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(error?.message ?? error) });
    }
  }
});

// Streamable-http reserves GET/DELETE on /mcp for sessions; we run stateless, so reject.
app.get("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed (stateless server)" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "method not allowed (stateless server)" }));

app.listen(PORT, () => {
  if (!INTERNAL_API_KEY) {
    console.warn("[scrum-service] WARNING: INTERNAL_API_KEY is not set — /mcp will reject all requests.");
  }
  console.log(JSON.stringify({ service: "scrum-service", version: VERSION, event: "listening", port: PORT }));
});
