"use strict";

/**
 * Test 1 (no Node-RED): stand up an Express app with the real MCP Streamable HTTP
 * endpoint, then connect with a REAL @modelcontextprotocol/sdk Client over the
 * StreamableHTTPClientTransport. Proves genuine Streamable HTTP compatibility.
 */

const http = require("http");
const express = require("express");
const { expect } = require("chai");

const {
  attachMcpStreamableEndpoint,
  normalizeResult,
} = require("../lib/mcp-streamable.js");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

// A real, non-trivial JSON Schema for the echo tool.
const ECHO_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "Text to echo back" },
    times: { type: "integer", minimum: 1, default: 1 },
  },
  required: ["message"],
};

describe("lib/mcp-streamable (real MCP client over Streamable HTTP)", function () {
  let server;
  let baseUrl;

  before(function (done) {
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    attachMcpStreamableEndpoint(app, {
      serverInfo: { name: "test-mcp-server", version: "2.0.0" },
      listTools: async () => [
        {
          name: "echo",
          description: "Echo the provided message",
          inputSchema: ECHO_SCHEMA,
        },
      ],
      callTool: async (name, args) => {
        if (name === "echo") {
          const times = args.times || 1;
          return { echoed: Array(times).fill(args.message).join(" ") };
        }
        throw new Error("Tool not found: " + name);
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
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  it("normalizeResult coerces strings/objects/MCP-shapes", function () {
    expect(normalizeResult("hi")).to.deep.equal({
      content: [{ type: "text", text: "hi" }],
    });
    const mcp = { content: [{ type: "text", text: "x" }] };
    expect(normalizeResult(mcp)).to.equal(mcp);
    expect(normalizeResult({ a: 1 }).content[0].text).to.equal('{"a":1}');
  });

  it("lists tools with their JSON Schema", async function () {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).to.have.lengthOf(1);
      const echo = tools[0];
      expect(echo.name).to.equal("echo");
      expect(echo.description).to.equal("Echo the provided message");
      // The raw JSON Schema must pass through untouched.
      expect(echo.inputSchema).to.deep.equal(ECHO_SCHEMA);
    });
  });

  it("calls a tool and returns a correct result", async function () {
    await withClient(async (client) => {
      const res = await client.callTool({
        name: "echo",
        arguments: { message: "ping", times: 3 },
      });
      expect(res.isError).to.not.equal(true);
      expect(res.content).to.be.an("array");
      // Tool returned an object → normalized to JSON text content.
      const text = res.content[0].text;
      expect(JSON.parse(text)).to.deep.equal({ echoed: "ping ping ping" });
    });
  });

  it("returns isError for an unknown tool", async function () {
    await withClient(async (client) => {
      const res = await client.callTool({
        name: "does-not-exist",
        arguments: {},
      });
      expect(res.isError).to.equal(true);
      expect(res.content[0].text).to.match(/not found/i);
    });
  });
});
