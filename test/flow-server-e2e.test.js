"use strict";

/**
 * Test 2 (Node-RED e2e via node-red-node-test-helper): load mcp-flow-server +
 * mcp-tool-registry, register a tool through the registry, start the server,
 * connect with a REAL MCP client, call the tool, handle mcp-tool-execute in the
 * "flow" and return mcp-tool-response — proving the registry -> server -> flow
 * bridge end to end.
 */

const helper = require("node-red-node-test-helper");
const { expect } = require("chai");

const flowServerNode = require("../mcp-flow-server.js");
const toolRegistryNode = require("../mcp-tool-registry.js");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

helper.init(require.resolve("node-red"));

const PORT = 18071;

describe("Node-RED e2e: registry -> flow-server -> flow", function () {
  before(function (done) {
    helper.startServer(done);
  });

  after(function (done) {
    helper.stopServer(done);
  });

  afterEach(function (done) {
    helper.unload().then(() => done());
  });

  it("registers a tool and executes it through the flow over a real MCP client", async function () {
    const addSchema = JSON.stringify({
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    });

    const flow = [
      { id: "tab", type: "tab", label: "Test flow" },
      {
        id: "reg",
        z: "tab",
        type: "mcp-tool-registry",
        name: "add-tool",
        toolName: "add",
        toolDescription: "Add two numbers",
        toolSchema: addSchema,
        autoRegister: true,
        wires: [[]],
      },
      {
        id: "srv",
        z: "tab",
        type: "mcp-flow-server",
        name: "e2e-server",
        serverName: "e2e-mcp",
        serverPort: String(PORT),
        autoStart: false,
        enableCors: true,
        wires: [["h"]],
      },
      { id: "h", z: "tab", type: "helper" },
    ];

    await helper.load([flowServerNode, toolRegistryNode], flow);

    const srv = helper.getNode("srv");
    const h = helper.getNode("h");

    // Wire up the "flow": when the server asks to execute a tool, compute the
    // result and feed an mcp-tool-response back into the server node's input.
    h.on("input", function (msg) {
      if (msg.topic === "mcp-tool-execute") {
        const { toolName, arguments: args, executionId } = msg.payload;
        let result;
        if (toolName === "add") {
          result = { sum: args.a + args.b };
        } else {
          result = { error: "unknown" };
        }
        srv.receive({
          topic: "mcp-tool-response",
          payload: { executionId, result },
        });
      }
    });

    // Give the registry node's autoRegister (500ms) time to fire, then start.
    await new Promise((r) => setTimeout(r, 800));

    // Start the server and wait until it reports running.
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("server did not start")), 5000);
      const onStarted = (msg) => {
        if (msg.topic === "mcp-server-started") {
          clearTimeout(to);
          h.removeListener("input", onStarted);
          resolve();
        }
      };
      h.on("input", onStarted);
      srv.receive({ topic: "start" });
    });

    // Connect a real MCP client and exercise the tool.
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${PORT}/mcp`)
    );
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).to.include("add");
      const addTool = tools.find((t) => t.name === "add");
      expect(addTool.inputSchema).to.deep.equal(JSON.parse(addSchema));

      const res = await client.callTool({
        name: "add",
        arguments: { a: 2, b: 5 },
      });
      expect(res.isError).to.not.equal(true);
      expect(JSON.parse(res.content[0].text)).to.deep.equal({ sum: 7 });
    } finally {
      await client.close();
    }
  });
});
