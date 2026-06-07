# node-red-contrib-mcp-server

A Node-RED contribution package for the Model Context Protocol (MCP). Its headline
node, **MCP Flow Server**, runs a **real, spec-compliant MCP server over the
Streamable HTTP transport** (built on the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)),
so any standard MCP client can connect to it. Tools are defined visually with
Node-RED nodes. The package also includes client/tool nodes for talking to
external MCP servers.

> **v2.0 — now a genuine MCP server.** Earlier versions hand-rolled a `POST /mcp`
> JSON-RPC switch and a fake `/sse` heartbeat, which standard MCP clients could not
> use. v2.0 replaces that with the official SDK's **Streamable HTTP** transport
> (stateless): real session/transport handling on `POST /mcp`, `GET`/`DELETE /mcp`
> returning `405`, MCP CORS headers, and tool results in proper MCP shape. See
> [CHANGELOG.md](CHANGELOG.md). This is a breaking change — see *Migration* below.

## The spec-compliant MCP Flow Server (Streamable HTTP)

Build an MCP server entirely from Node-RED flows:

1. Drop an **MCP Tool Registry** node for each tool. Give it a name, description and
   a raw **JSON Schema** for its input. It registers the tool with the server.
2. Drop an **MCP Flow Server** node. Set a port (default `8001`) and (optionally)
   Auto Start. It serves the MCP endpoint at `POST http://<host>:<port>/mcp`.
3. Wire the **MCP Flow Server** output to your flow logic. For every tool call the
   server emits a message `{ topic: 'mcp-tool-execute', payload: { toolName,
   arguments, executionId } }`. Compute the result and send a message back **into
   the MCP Flow Server node's input**:
   `{ topic: 'mcp-tool-response', payload: { executionId, result } }`
   (or `{ executionId, error }`). The call resolves with that result (30s timeout).

Tools are read from the registry on every `tools/list`, so adding/removing registry
nodes changes the advertised tools immediately (the transport is stateless).

### Connect with a standard MCP client

**JavaScript (`@modelcontextprotocol/sdk`):**
```js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8001/mcp')));

console.log(await client.listTools());
console.log(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }));
await client.close();
```

**Python (`mcp` — `streamablehttp_client`):**
```python
import asyncio
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    async with streamablehttp_client("http://localhost:8001/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print(await session.list_tools())
            print(await session.call_tool("echo", {"text": "hi"}))

asyncio.run(main())
```

### Migration from 1.x

- The fake `/sse` endpoint and the custom `POST /mcp` method switch are gone. Use a
  real MCP client over Streamable HTTP at `POST /mcp` instead.
- The `mcp-flow-server` / `mcp-tool-registry` node types, their config fields and the
  flow-execution contract (`mcp-tool-execute` → `mcp-tool-response`) are unchanged,
  so existing flow-server/registry flows keep working.
- Requires Node.js ≥ 18 and Node-RED ≥ 3.

## Features

- **🚀 MCP Server Management**: Start, stop, and monitor MCP servers directly from Node-RED
- **🔗 Multi-Protocol Support**: HTTP, Server-Sent Events (SSE), and WebSocket connections
- **🛠️ Tool Integration**: Direct invocation of MCP tools with parameter mapping
- **💾 Health Monitoring**: Automatic health checks and restart capabilities
- **📊 Real-time Communication**: Live streaming of server output and events
- **🎯 Omnispindle Integration**: Built-in presets for the Omnispindle MCP server

## Installation

### From npm (when published)
```bash
cd ~/.node-red
npm install node-red-contrib-mcp-server
```

### Manual Installation
```bash
cd ~/.node-red
git clone <repository-url> node_modules/node-red-contrib-mcp-server
cd node_modules/node-red-contrib-mcp-server
npm install
```

### Local Development
```bash
cd /path/to/node-red-contrib-mcp-server
npm link
cd ~/.node-red
npm link node-red-contrib-mcp-server
```

## Quick Start with Examples

The package includes ready-to-use example flows to get you started quickly:

### 📁 External MCP Server Example
Demonstrates connecting to external MCP servers like Omnispindle:
- **File**: `examples/external-mcp-server-example.json`
- **Shows**: SSE connection, tool discovery, direct tool calls
- **Setup**: Import → Deploy → Watch debug output

### 🏗️ Flow-Based MCP Server Example  
Demonstrates creating MCP servers entirely within Node-RED:
- **File**: `examples/flow-based-mcp-server-example.json`
- **Shows**: Custom tools, visual server creation, self-testing
- **Setup**: Import → Deploy → Server runs on port 8001

### How to Import Examples
1. In Node-RED: Menu (☰) → Import
2. Select "select a file to import"  
3. Choose an example JSON file from the `examples/` directory
4. Click "Import" and deploy

For detailed setup instructions, see [`examples/README.md`](examples/README.md).

## Nodes

### 🖥️ MCP Server Node

Manages the lifecycle of MCP server processes.

**Key Features:**
- Start/stop MCP servers (Python, Node.js, or custom commands)
- Health monitoring with automatic restarts
- Real-time output streaming
- Environment variable configuration
- Port management

**Configuration:**
- **Server Type**: Python, Node.js, or Custom
- **Server Path**: Path to server script/executable
- **Server Arguments**: Command line arguments
- **Port**: Server port number
- **Auto Start**: Start with Node-RED
- **Health Checks**: Monitor server health
- **Restart Policy**: Automatic restart on failure

**Input Commands:**
- `start`: Start the server
- `stop`: Stop the server  
- `restart`: Restart the server
- `status`: Get current status

**Output Topics:**
- `stdout`: Server standard output
- `stderr`: Server error output
- `started`: Server startup event
- `exit`: Server exit event

### 🔗 MCP Client Node

Connects to and communicates with MCP servers.

**Key Features:**
- Multiple connection types (HTTP, SSE, WebSocket)
- Automatic reconnection
- Request/response handling
- Real-time event streaming
- Connection pooling

**Configuration:**
- **Server URL**: MCP server endpoint
- **Connection Type**: HTTP, SSE, or WebSocket
- **Auto Connect**: Connect on startup
- **Reconnect**: Auto-reconnect on disconnect
- **Timeout**: Request timeout

**Input Commands:**
- `connect`: Establish connection
- `disconnect`: Close connection
- `request`: Send MCP request
- `status`: Get connection status

**Output Topics:**
- `connected`: Connection established
- `response`: MCP response received
- `message`: General server message
- `error`: Error occurred
- `raw`: Unparsed message data

### ⚙️ MCP Tool Node

Simplified interface for invoking specific MCP tools.

**Key Features:**
- Predefined tool configurations
- Parameter mapping and overrides
- Output formatting options
- Dynamic tool discovery
- Omnispindle tool presets

**Configuration:**
- **Server URL**: MCP server endpoint
- **Tool Name**: MCP tool to invoke
- **Default Parameters**: JSON parameter defaults
- **Output Mode**: Result formatting
- **Timeout**: Request timeout

**Parameter Override Priority:**
1. Message-specific properties (`msg.description`, `msg.project`, etc.)
2. `msg.payload.params` object
3. `msg.payload` (if object without method)
4. Default parameters from configuration

**Output Modes:**
- **Result Only**: Extract result from MCP response
- **Full Response**: Complete MCP JSON-RPC response
- **Custom**: Preserve original message, add response

## Examples

### Basic MCP Server Setup

```javascript
// Use MCP Server node with these settings:
// Server Type: Python
// Server Path: src/Omnispindle/__init__.py
// Server Args: --host 0.0.0.0 --port 8000
// Auto Start: true
```

### Client Connection and Tool Call

```javascript
// Connect to MCP server
msg.topic = "connect";
return msg;

// Later: Call a tool
msg.topic = "request";
msg.payload = {
    method: "add_todo_tool",
    params: {
        description: "Implement MCP integration",
        project: "NodeRED"
    }
};
return msg;
```

### Direct Tool Invocation

```javascript
// Configure MCP Tool node for "add_todo_tool"
// Then send:
msg.description = "New task from Node-RED";
msg.project = "MyProject";
msg.priority = "High";
return msg;
```

### Server Lifecycle Management

```javascript
// Start server
msg.topic = "start";
return msg;

// Monitor output
// Connect to stdout output and process server logs

// Stop server when done
msg.topic = "stop";
return msg;
```

## Omnispindle Integration

This package includes built-in support for the Omnispindle MCP server:

### Available Tools
- `add_todo_tool` - Create new todos
- `list_todos_by_status_tool` - List todos by status
- `update_todo_tool` - Update existing todos
- `delete_todo_tool` - Delete todos
- `mark_todo_complete_tool` - Mark todos complete
- `list_project_todos_tool` - List project todos
- `query_todos_tool` - Search/query todos

### Quick Setup
1. Use "Load Omnispindle Preset" buttons in node configurations
2. Automatically configures for local Omnispindle server
3. Sets appropriate connection types and parameters

## Advanced Usage

### Health Monitoring Flow

```javascript
// MCP Server node output → Function node:
if (msg.topic === "stdout" && msg.payload.includes("error")) {
    // Alert on errors
    return {topic: "alert", payload: "Server error detected"};
}
if (msg.topic === "exit" && msg.payload.code !== 0) {
    // Server crashed
    return {topic: "restart", payload: {}};
}
```

### Dynamic Tool Discovery

```javascript
// Function node to get available tools:
msg.topic = "request";
msg.payload = {
    method: "tools/list",
    params: {}
};
return msg;

// Process response to populate UI or routing
```

### Connection Failover

```javascript
// Function node for client failover:
if (msg.topic === "error") {
    // Try backup server
    msg.topic = "connect";
    msg.payload = {serverUrl: "http://backup:8000"};
    return msg;
}
```

## API Endpoints

The MCP Flow Server serves the spec endpoint:

- `POST /mcp` — the real MCP Streamable HTTP transport (standard MCP clients)
- `GET /mcp`, `DELETE /mcp` — `405 Method Not Allowed` (stateless server)
- `GET /health` — health/uptime/registered-tool count

Admin (editor) endpoints, each protected with `RED.auth.needsPermission`:

- `GET /mcp-flow-servers` — list running flow servers
- `GET /mcp-servers` - List running MCP servers
- `GET /mcp-tools/:serverUrl` - Get available tools from server

## Requirements

### System Requirements
- Node.js 18 or higher
- Node-RED 3.0.0 or higher

### MCP Server Requirements
- **Python servers**: Python 3.8+ with required packages
- **Node.js servers**: Node.js 16+ with required packages  
- **Custom servers**: Executable in PATH or full path specified

### Dependencies
- `@modelcontextprotocol/sdk` - official MCP SDK (Streamable HTTP server/client)
- `express` - HTTP server for the MCP endpoint
- `node-cache` - tool/server registry
- `uuid` - Unique ID generation
- `axios`, `ws`, `eventsource` - used by the external client/tool nodes

All dependencies are compatible with Node.js 18; the package installs cleanly on
Node 18 with no `EBADENGINE` warnings.

## Troubleshooting

### Server Won't Start
- Check server path exists and is executable
- Verify Python/Node.js environment
- Check port availability
- Review server arguments syntax

### Connection Issues
- Verify server is running and accessible
- Check firewall settings
- Confirm correct URL and port
- Test with simple HTTP health check

### Tool Calls Fail
- Ensure server supports the requested tool
- Validate parameter JSON syntax
- Check server logs for errors
- Verify authentication if required

### Performance Issues
- Adjust health check intervals
- Configure appropriate timeouts
- Use connection pooling for high volume
- Monitor server resource usage

## Development

### Contributing
1. Fork the repository
2. Create feature branch
3. Add tests for new functionality
4. Submit pull request

### Testing
```bash
npm test
```

### Building
```bash
npm run build
```

## License

MIT License - see LICENSE file for details.

## Changelog

### v1.0.0
- Initial release
- MCP Server, Client, and Tool nodes
- Omnispindle integration
- Multi-protocol support
- Health monitoring
- Auto-restart capabilities

## Support

- 📖 [Documentation](https://github.com/MadnessEngineering/node-red-contrib-mcp-server)
- 🐛 [Issues](https://github.com/MadnessEngineering/node-red-contrib-mcp-server/issues)
- 💬 [Discussions](https://github.com/MadnessEngineering/node-red-contrib-mcp-server/discussions)

## Related Projects

- [Omnispindle](https://github.com/MadnessEngineering/Omnispindle) - FastMCP-based todo management system
- [FastMCP](https://github.com/jlowin/fastmcp) - Model Context Protocol server framework
- [Node-RED](https://nodered.org/) - Flow-based programming for the Internet of Things 
