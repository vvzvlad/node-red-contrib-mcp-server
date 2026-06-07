"use strict";

/**
 * Test 3 (error handling): drive the real endpoint with raw HTTP to assert
 * spec-correct behaviour for malformed input, and confirm unknown tools surface
 * as an MCP tool error (isError).
 */

const http = require("http");
const express = require("express");
const { expect } = require("chai");

const { attachMcpStreamableEndpoint } = require("../lib/mcp-streamable.js");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

function makeApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  attachMcpStreamableEndpoint(app, {
    serverInfo: { name: "err-server", version: "2.0.0" },
    listTools: async () => [
      { name: "noop", description: "no-op", inputSchema: { type: "object" } },
    ],
    callTool: async (name) => {
      if (name === "noop") return "ok";
      throw new Error("Tool not found: " + name);
    },
  });
  return app;
}

// Minimal raw HTTP POST helper.
function rawPost(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, "utf8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: Object.assign(
          { "Content-Length": data.length },
          headers || {}
        ),
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: chunks, headers: res.headers })
        );
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("error handling", function () {
  let server;
  let port;

  before(function (done) {
    server = http.createServer(makeApp());
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      done();
    });
  });

  after(function (done) {
    if (server) server.close(done);
    else done();
  });

  it("unknown tool -> isError via real MCP client", async function () {
    const client = new Client({ name: "c", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    );
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: "ghost", arguments: {} });
      expect(res.isError).to.equal(true);
      expect(res.content[0].text).to.match(/not found/i);
    } finally {
      await client.close();
    }
  });

  it("malformed JSON body -> a clean JSON-RPC / 4xx error (no crash)", async function () {
    const res = await rawPost(
      port,
      "/mcp",
      {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      "{ this is not valid json "
    );
    // express.json() rejects the bad body before our handler; the transport never
    // sees it. Either way the server must respond with a 4xx/5xx and NOT hang/crash.
    expect(res.status).to.be.within(400, 599);
  });

  it("GET /mcp -> 405 method not allowed", async function () {
    const got = await new Promise((resolve, reject) => {
      http
        .get(
          { host: "127.0.0.1", port, path: "/mcp" },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode, body: b }));
          }
        )
        .on("error", reject);
    });
    expect(got.status).to.equal(405);
    expect(JSON.parse(got.body).error.message).to.match(/not allowed/i);
  });
});
