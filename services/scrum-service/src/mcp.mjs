// MCP server definition: exposes the scrum capabilities as MCP tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { changeCheck, exportRows, overview } from "./capabilities.mjs";

const VERSION = "0.1.0";

function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: String(error?.message ?? error) }, null, 2) }],
  };
}

// A fresh server instance per request keeps the stateless HTTP transport simple.
export function buildServer() {
  const server = new McpServer({ name: "scrum-service", version: VERSION });

  server.registerTool(
    "scrum_overview",
    {
      title: "Scrum DB overview",
      description:
        "List scrum-relevant Postgres tables (feedback/tasks/sprints/participants/risks) with row counts, latest timestamps and columns. Read-only.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await overview());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "scrum_change_check",
    {
      title: "Scrum DB change check",
      description:
        "Detect rows added to scrum tables since the previous call (stateful). Returns { baseline, changes[] }; for new feedback it includes the latest rows. Read-only.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await changeCheck());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "scrum_export",
    {
      title: "Scrum DB export",
      description: "Export latest rows from a scrum table category. Read-only.",
      inputSchema: {
        kind: z
          .enum(["all", "feedback", "tasks", "sprints", "participants", "risks"])
          .default("all")
          .describe("Which category of scrum tables to export."),
        limit: z.number().int().positive().max(1000).default(50).describe("Max rows per table (capped at 1000)."),
      },
    },
    async ({ kind, limit }) => {
      try {
        return jsonResult(await exportRows({ kind, limit }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export { VERSION };
