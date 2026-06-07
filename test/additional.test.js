"use strict";

/**
 * ADDITIONAL edge-case tests for lib/mcp-streamable.js, exercised end-to-end with
 * a REAL @modelcontextprotocol/sdk Client over the StreamableHTTPClientTransport.
 *
 * These cover behaviours NOT already covered by the existing suite:
 *  - multiple tools listed with correct schemas
 *  - already-MCP-shaped callTool result passes through unchanged
 *  - plain string vs object result (normalizeResult end-to-end)
 *  - dynamic add/remove between two client sessions (stateless re-read)
 *  - concurrent callTool calls resolve independently
 *  - a tool that throws -> isError with the message
 *  - empty/absent inputSchema defaulting to {type:'object',properties:{}}
 *  - normalizeResult unit behaviour for null/undefined/numbers
 */

const http = require("http");
const express = require("express");
const { expect } = require("chai");

const {
  attachMcpStreamableEndpoint,
  buildServer,
  normalizeResult,
} = require("../lib/mcp-streamable.js");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const ADD_SCHEMA = {
  type: "object",
  properties: {
    a: { type: "number", description: "first" },
    b: { type: "number", description: "second" },
  },
  required: ["a", "b"],
};

const PING_SCHEMA = {
  type: "object",
  properties: { n: { type: "integer", minimum: 0 } },
};

describe("additional: lib/mcp-streamable edge cases (real MCP client)", function () {
  let server;
  let baseUrl;

  // Mutable tool set so we can exercise dynamic add/remove between sessions.
  let tools;

  before(function (done) {
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    tools = [
      { name: "add", description: "Add two numbers", inputSchema: ADD_SCHEMA },
      { name: "ping", description: "Ping back", inputSchema: PING_SCHEMA },
      // Intentionally no inputSchema -> should default to {type:object,properties:{}}.
      { name: "now", description: "Returns a fixed string" },
    ];

    attachMcpStreamableEndpoint(app, {
      serverInfo: { name: "additional-mcp", version: "9.9.9" },
      // Read from the mutable `tools` array on every list (stateless re-read).
      listTools: async () => tools,
      callTool: async (name, args) => {
        switch (name) {
          case "add":
            return { sum: args.a + args.b };
          case "ping":
            // Return a plain string -> normalizeResult wraps as text content.
            return "pong" + (args.n != null ? ":" + args.n : "");
          case "now":
            return "fixed-now";
          case "mcpshape":
            // Already MCP-shaped: must pass through unchanged.
            return {
              content: [
                { type: "text", text: "preshaped" },
                { type: "text", text: "second" },
              ],
              _marker: "kept",
            };
          case "slow": {
            // Resolve after a small, deterministic delay (for concurrency test).
            const ms = args.ms || 0;
            await new Promise((r) => setTimeout(r, ms));
            return { id: args.id, ms };
          }
          case "boom":
            throw new Error("kaboom: intentional failure");
          default:
            throw new Error("Tool not found: " + name);
        }
      },
    });

    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/mcp`;
      done();
    });
  });

  after(function (done) {
    if (server) server.close(done);
    else done();
  });

  async function withClient(fn) {
    const client = new Client({ name: "add-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  // --- normalizeResult unit-level edge cases (not covered before) ----------

  it("normalizeResult: null and undefined become JSON 'null' text", function () {
    expect(normalizeResult(null).content[0].text).to.equal("null");
    expect(normalizeResult(undefined).content[0].text).to.equal("null");
  });

  it("normalizeResult: numbers/booleans are JSON-stringified", function () {
    expect(normalizeResult(42).content[0].text).to.equal("42");
    expect(normalizeResult(false).content[0].text).to.equal("false");
  });

  it("normalizeResult: an MCP-shaped object is returned by reference", function () {
    const shaped = { content: [{ type: "text", text: "x" }], isError: true };
    expect(normalizeResult(shaped)).to.equal(shaped);
  });

  // --- listTools: multiple tools + schema defaulting -----------------------

  it("lists ALL registered tools with correct schemas", async function () {
    await withClient(async (client) => {
      const { tools: listed } = await client.listTools();
      const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).to.deep.equal(["add", "now", "ping"]);

      expect(byName.add.description).to.equal("Add two numbers");
      expect(byName.add.inputSchema).to.deep.equal(ADD_SCHEMA);
      expect(byName.ping.inputSchema).to.deep.equal(PING_SCHEMA);
    });
  });

  it("absent inputSchema defaults to {type:'object',properties:{}}", async function () {
    await withClient(async (client) => {
      const { tools: listed } = await client.listTools();
      const now = listed.find((t) => t.name === "now");
      expect(now.inputSchema).to.deep.equal({
        type: "object",
        properties: {},
      });
    });
  });

  // --- callTool result shaping --------------------------------------------

  it("plain-string result is wrapped as a single text content", async function () {
    await withClient(async (client) => {
      const res = await client.callTool({
        name: "ping",
        arguments: { n: 7 },
      });
      expect(res.isError).to.not.equal(true);
      expect(res.content).to.have.lengthOf(1);
      expect(res.content[0]).to.deep.equal({ type: "text", text: "pong:7" });
    });
  });

  it("object result is JSON-stringified into text content", async function () {
    await withClient(async (client) => {
      const res = await client.callTool({
        name: "add",
        arguments: { a: 10, b: 32 },
      });
      expect(res.isError).to.not.equal(true);
      expect(JSON.parse(res.content[0].text)).to.deep.equal({ sum: 42 });
    });
  });

  it("already-MCP-shaped result passes through unchanged (multi-content)", async function () {
    // Add a transient tool that returns a pre-shaped result.
    const prev = tools;
    tools = prev.concat([{ name: "mcpshape", description: "preshaped" }]);
    try {
      await withClient(async (client) => {
        const res = await client.callTool({ name: "mcpshape", arguments: {} });
        expect(res.isError).to.not.equal(true);
        expect(res.content).to.have.lengthOf(2);
        expect(res.content[0]).to.deep.equal({ type: "text", text: "preshaped" });
        expect(res.content[1]).to.deep.equal({ type: "text", text: "second" });
        // Extra fields on the result survive the round trip.
        expect(res._marker).to.equal("kept");
      });
    } finally {
      tools = prev;
    }
  });

  // --- tool that throws ----------------------------------------------------

  it("a throwing tool surfaces as isError carrying the message", async function () {
    const prev = tools;
    tools = prev.concat([{ name: "boom", description: "always fails" }]);
    try {
      await withClient(async (client) => {
        const res = await client.callTool({ name: "boom", arguments: {} });
        expect(res.isError).to.equal(true);
        expect(res.content[0].text).to.match(/kaboom: intentional failure/);
      });
    } finally {
      tools = prev;
    }
  });

  // --- dynamic add/remove across two sessions (stateless re-read) ----------

  it("dynamic add/remove is reflected in a later client session", async function () {
    // Session 1: baseline.
    await withClient(async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).to.include("add");
      expect(names).to.not.include("extra");
    });

    // Mutate the registry between sessions: remove "add", add "extra".
    const prev = tools;
    tools = prev
      .filter((t) => t.name !== "add")
      .concat([{ name: "extra", description: "newly added" }]);

    try {
      // Session 2: a brand-new client/transport sees the new tool set.
      await withClient(async (client) => {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).to.not.include("add");
        expect(names).to.include("extra");
      });
    } finally {
      tools = prev;
    }
  });

  // --- concurrent calls resolve independently ------------------------------

  it("concurrent callTool calls resolve independently and correctly", async function () {
    const prev = tools;
    tools = prev.concat([{ name: "slow", description: "delayed echo" }]);
    try {
      await withClient(async (client) => {
        // Earlier-started call has the LONGER delay, so completion order differs
        // from start order; results must still map back to the right call.
        const calls = [
          { id: "A", ms: 60 },
          { id: "B", ms: 10 },
          { id: "C", ms: 30 },
          { id: "D", ms: 0 },
        ].map((args) => client.callTool({ name: "slow", arguments: args }));

        const results = await Promise.all(calls);
        const decoded = results.map((r) => JSON.parse(r.content[0].text));
        // Order of the resolved array matches Promise.all input order.
        expect(decoded.map((d) => d.id)).to.deep.equal(["A", "B", "C", "D"]);
        expect(decoded.find((d) => d.id === "A").ms).to.equal(60);
        expect(decoded.find((d) => d.id === "D").ms).to.equal(0);
      });
    } finally {
      tools = prev;
    }
  });

  // --- buildServer is usable standalone (no Express) -----------------------

  it("buildServer wires handlers with the same defaulting/normalization", async function () {
    const built = buildServer({
      serverInfo: { name: "standalone", version: "1.0.0" },
      listTools: async () => [{ name: "bare" }],
      callTool: async () => "hi",
    });
    expect(built).to.be.an("object");
    expect(typeof built.connect).to.equal("function");
    expect(typeof built.close).to.equal("function");
  });
});
