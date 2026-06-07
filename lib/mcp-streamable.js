"use strict";

/**
 * Real, spec-compliant MCP server endpoint over the Streamable HTTP transport,
 * built on the official @modelcontextprotocol/sdk (stable 1.x).
 *
 * This module has NO dependency on Node-RED so it can be unit-tested in isolation
 * with a real MCP client.
 *
 * Design: STATELESS Streamable HTTP. A fresh low-level `Server` and
 * `StreamableHTTPServerTransport` are created per request (sessionIdGenerator =
 * undefined). Because tools are read from the provided `listTools` callback on
 * every `tools/list`, dynamic add/remove of tools works without listChanged
 * notifications.
 *
 * We use the LOW-LEVEL `Server` (not `McpServer`) on purpose: tools are described
 * by RAW JSON Schema (no Zod). `setRequestHandler(ListToolsRequestSchema/
 * CallToolRequestSchema)` lets us pass `inputSchema` through untouched and dispatch
 * calls ourselves.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

/**
 * Coerce an arbitrary tool result into the MCP CallTool result shape.
 * @param {*} result
 * @returns {{content: Array<object>, [k:string]: any}}
 */
function normalizeResult(result) {
  // Already an MCP-shaped result ({ content: [...] }) — pass through unchanged.
  if (result && Array.isArray(result.content)) return result;
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
}

/**
 * Build a low-level MCP Server wired to the provided callbacks.
 * @param {object} opts
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {() => Promise<Array<{name:string, description?:string, inputSchema?:object}>>} opts.listTools
 * @param {(name:string, args:object) => Promise<*>} opts.callTool
 * @returns {import('@modelcontextprotocol/sdk/server/index.js').Server}
 */
function buildServer({ serverInfo, listTools, callTool }) {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = (await listTools()) || [];
    // Ensure every tool exposes a valid JSON Schema inputSchema.
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return normalizeResult(await callTool(name, args || {}));
    } catch (e) {
      // Report tool failures as an MCP tool error (isError) rather than a
      // transport-level JSON-RPC error, per the spec.
      return {
        isError: true,
        content: [{ type: "text", text: String((e && e.message) || e) }],
      };
    }
  });

  return server;
}

/**
 * Attach a real MCP Streamable HTTP endpoint to an existing Express app.
 *
 * The express app MUST already have `express.json()` mounted so `req.body` is the
 * parsed JSON-RPC payload.
 *
 * @param {import('express').Express} app
 * @param {object} opts
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {() => Promise<Array>} opts.listTools
 * @param {(name:string, args:object) => Promise<*>} opts.callTool
 * @param {{error?:Function, log?:Function}} [opts.logger]
 */
function attachMcpStreamableEndpoint(app, opts) {
  const logger = opts.logger || {};
  const logError = typeof logger.error === "function" ? logger.error : () => {};

  app.post("/mcp", async (req, res) => {
    // Stateless: a brand new Server + transport for every request.
    const server = buildServer(opts);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    // Clean up when the HTTP response is done.
    res.on("close", () => {
      try {
        transport.close();
      } catch (_) {
        /* ignore */
      }
      try {
        server.close();
      } catch (_) {
        /* ignore */
      }
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logError("MCP /mcp request error: " + String((e && e.message) || e));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String((e && e.message) || e) },
          id: null,
        });
      }
    }
  });

  // The stateless Streamable HTTP server does not support GET (server-initiated
  // SSE stream) or DELETE (session teardown). Respond per spec.
  const notAllowed = (req, res) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Final error handler: turn body-parser / unexpected errors (e.g. malformed
  // JSON) into a clean JSON-RPC error instead of Express's default HTML page.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 400;
    const isParse = err.type === "entity.parse.failed" || err instanceof SyntaxError;
    logError("MCP request error: " + String((err && err.message) || err));
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: isParse ? -32700 : -32603,
        message: (isParse ? "Parse error: " : "") + String((err && err.message) || err),
      },
      id: null,
    });
  });
}

module.exports = { attachMcpStreamableEndpoint, buildServer, normalizeResult };
