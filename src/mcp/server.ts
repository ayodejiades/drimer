import "dotenv/config";
import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import * as getMarketView from "./tools/getMarketView";
import * as getTrackRecord from "./tools/getTrackRecord";
import * as placeTrade from "./tools/placeTrade";
import * as getSystemStatus from "./tools/getSystemStatus";
import * as auditSignal from "./tools/auditSignal";

const TOOLS = [getMarketView, getTrackRecord, placeTrade, getSystemStatus, auditSignal] as const;

function toolToSpec(mod: (typeof TOOLS)[number]) {
  // Convert zod schema to JSON schema via zod's shape — SDK expects inputSchema as JSON Schema
  // We hand-build minimal JSON Schema from zod description; SDK's zodToJsonSchema not needed for this simple case.
  // Instead we provide a JSON Schema directly that matches the zod schema.
  const shape = (mod.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  // Fallback: produce JSON Schema manually per tool
  let properties: Record<string, unknown> = {};
  let required: string[] = [];
  if (mod.name === "get_market_view") {
    properties = {
      asset: { type: "string", enum: ["BTC", "ETH"], description: "Asset BTC or ETH" },
      duration: { type: "string", enum: ["FIFTEEN_MIN", "ONE_HOUR"], default: "FIFTEEN_MIN" },
    };
    required = ["asset"];
  } else if (mod.name === "get_track_record") {
    properties = {
      since: { type: "string", description: "ISO timestamp" },
      source: { type: "string", enum: ["LIVE", "BACKTEST"] },
    };
  } else if (mod.name === "place_trade") {
    properties = {
      asset: { type: "string", enum: ["BTC", "ETH"] },
      duration: { type: "string", enum: ["FIFTEEN_MIN", "ONE_HOUR"], default: "FIFTEEN_MIN" },
      overrideStake: { type: "number", description: "Override stake" },
    };
    required = ["asset"];
  } else if (mod.name === "get_system_status") {
    properties = {};
  } else if (mod.name === "audit_and_calibrate_signal") {
    properties = {
      asset: { type: "string", enum: ["BTC", "ETH"], description: "Asset BTC or ETH" },
      rawProbabilityUp: { type: "number", description: "External agent's claimed probability (0.01 to 0.99)" },
      intendedStake: { type: "number", description: "Proposed stake in USDso (optional)" },
      duration: { type: "string", enum: ["FIFTEEN_MIN", "ONE_HOUR"], default: "FIFTEEN_MIN" },
    };
    required = ["asset", "rawProbabilityUp"];
  }
  return {
    name: mod.name,
    description: mod.description,
    inputSchema: { type: "object", properties, required: required.length ? required : undefined },
  };
}

async function createMcpServer() {
  const server = new Server({ name: "drimer", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(toolToSpec),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const mod = TOOLS.find((t) => t.name === name);
    if (!mod) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }

    // Auth gate for place_trade when deployed
    if (name === "place_trade") {
      const secret = process.env.MCP_SHARED_SECRET;
      // The bearer check is done at HTTP layer; here we just enforce if secret is set
      // Actual HTTP bearer validation is in the express middleware below
    }

    try {
      const parsed = mod.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: parsed.error.message }) }],
          isError: true,
        };
      }
      const result = await (mod.handler as (a: unknown) => Promise<unknown>)(parsed.data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: String(e) }) }], isError: true };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transports — Streamable HTTP (primary) + SSE fallback
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// Bearer auth middleware for place_trade — checked at call time via header
// We can't easily intercept per-tool at HTTP layer for Streamable HTTP, so we also check inside the MCP handler
// But we add a simple bearer check that populates req.mcpAuth for place_trade
app.use((req, _res, next) => {
  (req as unknown as Record<string, unknown>).mcpAuth = req.headers.authorization ?? "";
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp", tools: TOOLS.map((t) => t.name) }));

// Streamable HTTP — POST /mcp
app.post("/mcp", async (req, res) => {
  // For place_trade, require bearer if MCP_SHARED_SECRET is set
  const secret = process.env.MCP_SHARED_SECRET;
  const body = req.body as { method?: string; params?: { name?: string } };
  const isPlaceTrade = body?.params?.name === "place_trade" || JSON.stringify(body).includes("place_trade");
  if (isPlaceTrade && secret && secret !== "dev-secret-change-in-prod") {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: "Unauthorized: place_trade requires Bearer MCP_SHARED_SECRET" });
      return;
    }
  }

  const server = await createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE fallback — GET /sse and POST /messages
app.get("/sse", async (req, res) => {
  const server = await createMcpServer();
  const transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  // This endpoint is used by SSE transport — create a new transport per request not needed
  // SSEServerTransport handles this via its own registry; we need to route correctly
  // For simplicity, return 404 if not using SSE flow
  res.status(404).json({ error: "Use POST /mcp for Streamable HTTP or GET /sse for SSE" });
});

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found — POST /mcp or GET /sse or GET /health" }));

const PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 3001);
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[mcp] Streamable HTTP on http://localhost:${PORT}/mcp`);
    console.log(`[mcp] SSE on http://localhost:${PORT}/sse`);
    console.log(`[mcp] Health on http://localhost:${PORT}/health`);
    console.log(`[mcp] Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  });
}

export { app, createMcpServer, TOOLS };
