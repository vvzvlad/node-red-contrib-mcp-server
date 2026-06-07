module.exports = function (RED)
{
    "use strict";

    const http = require('http');
    const express = require('express');
    const { v4: uuidv4 } = require('uuid');
    const NodeCache = require('node-cache');
    const { attachMcpStreamableEndpoint } = require('./lib/mcp-streamable.js');

    // Global registry for tools across all flow server instances.
    const toolRegistry = new NodeCache({ stdTTL: 0 });
    const serverInstances = new NodeCache({ stdTTL: 0 });

    function MCPFlowServerNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        node.serverName = config.serverName || "node-red-mcp-server";
        node.serverPort = parseInt(config.serverPort, 10) || 8001;
        node.autoStart = config.autoStart || false;
        // Preserve the original (truthy-by-default) CORS behaviour.
        node.enableCors = config.enableCors === undefined ? true : config.enableCors;

        // Runtime state
        node.httpServer = null;
        node.app = null;
        node.isRunning = false;
        node.serverId = uuidv4();

        node.status({ fill: "grey", shape: "ring", text: "stopped" });

        // Initialize the Express app that hosts the MCP Streamable HTTP endpoint.
        node.initializeServer = function ()
        {
            node.app = express();

            // CORS, including the headers required by the MCP Streamable HTTP
            // transport (session id + protocol version).
            if (node.enableCors)
            {
                node.app.use((req, res, next) =>
                {
                    res.header('Access-Control-Allow-Origin', '*');
                    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
                    res.header('Access-Control-Allow-Headers',
                        'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
                    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
                    if (req.method === 'OPTIONS')
                    {
                        res.sendStatus(200);
                    } else
                    {
                        next();
                    }
                });
            }

            // JSON body parsing (required by the Streamable HTTP transport).
            node.app.use(express.json({ limit: '10mb' }));

            // Health check endpoint.
            node.app.get('/health', (req, res) =>
            {
                res.json({
                    status: 'healthy',
                    server: node.serverName,
                    uptime: process.uptime(),
                    tools: toolRegistry.keys().length
                });
            });

            // Real, spec-compliant MCP endpoint on POST /mcp (GET/DELETE -> 405).
            // Tools are read from the registry on every request, so dynamic
            // add/remove works without listChanged notifications (stateless).
            attachMcpStreamableEndpoint(node.app, {
                serverInfo: { name: node.serverName, version: '2.0.0' },
                listTools: async () => toolRegistry.keys().map((k) =>
                {
                    const t = toolRegistry.get(k);
                    return {
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema || { type: 'object', properties: {} }
                    };
                }),
                callTool: async (name, args) =>
                {
                    const t = toolRegistry.get(name);
                    if (!t) throw new Error('Tool not found: ' + name);
                    return node.executeToolFlow(t, args);
                },
                logger: {
                    error: (m) => node.error(m),
                    log: (m) => node.log(m)
                }
            });
        };

        // Execute a registered tool by emitting a message into the flow and
        // resolving when the matching mcp-tool-response comes back to this node.
        node.executeToolFlow = function (tool, args)
        {
            return new Promise((resolve, reject) =>
            {
                const executionMsg = {
                    topic: 'mcp-tool-execute',
                    payload: {
                        toolName: tool.name,
                        arguments: args,
                        executionId: uuidv4()
                    }
                };

                const timeout = setTimeout(() =>
                {
                    node.removeListener('input', responseHandler);
                    reject(new Error('Tool execution timeout'));
                }, 30000);

                const responseHandler = (msg) =>
                {
                    if (msg.topic === 'mcp-tool-response' &&
                        msg.payload && msg.payload.executionId === executionMsg.payload.executionId)
                    {
                        clearTimeout(timeout);
                        node.removeListener('input', responseHandler);

                        if (msg.payload.error)
                        {
                            reject(new Error(msg.payload.error));
                        } else
                        {
                            resolve(msg.payload.result);
                        }
                    }
                };

                node.on('input', responseHandler);
                node.send(executionMsg);
            });
        };

        // Start the HTTP server.
        node.startServer = function (callback = () => { })
        {
            if (node.isRunning)
            {
                callback(null, { success: false, message: "Server already running" });
                return;
            }

            node.status({ fill: "yellow", shape: "ring", text: "starting..." });

            try
            {
                node.initializeServer();

                node.httpServer = http.createServer(node.app);

                node.httpServer.listen(node.serverPort, () =>
                {
                    node.isRunning = true;
                    node.status({ fill: "green", shape: "dot", text: `running :${node.serverPort}` });

                    // Store only primitives to avoid NodeCache cloning issues.
                    serverInstances.set(node.serverId, {
                        nodeId: String(node.id),
                        serverName: String(node.serverName),
                        port: Number(node.serverPort),
                        startTime: new Date().toISOString(),
                        isRunning: true
                    });

                    node.log(`MCP Flow Server started on port ${node.serverPort} (Streamable HTTP at POST /mcp)`);

                    node.send({
                        topic: "mcp-server-started",
                        payload: {
                            serverId: node.serverId,
                            serverName: node.serverName,
                            port: node.serverPort,
                            startTime: new Date()
                        }
                    });

                    callback(null, { success: true, message: "Server started" });
                });

                node.httpServer.on('error', (error) =>
                {
                    node.error(`Server error: ${error.message}`);
                    node.status({ fill: "red", shape: "dot", text: "error" });
                    callback(error);
                });

            } catch (error)
            {
                node.error(`Failed to start server: ${error.message}`);
                node.status({ fill: "red", shape: "dot", text: "error" });
                callback(error);
            }
        };

        // Stop the HTTP server.
        node.stopServer = function (callback = () => { })
        {
            if (!node.isRunning)
            {
                callback(null, { success: true, message: "Server already stopped" });
                return;
            }

            node.status({ fill: "yellow", shape: "ring", text: "stopping..." });

            if (node.httpServer)
            {
                node.httpServer.close(() =>
                {
                    node.isRunning = false;
                    node.httpServer = null;
                    node.status({ fill: "grey", shape: "ring", text: "stopped" });
                    serverInstances.del(node.serverId);

                    node.send({
                        topic: "mcp-server-stopped",
                        payload: { serverId: node.serverId }
                    });

                    callback(null, { success: true, message: "Server stopped" });
                });
            } else
            {
                node.isRunning = false;
                node.status({ fill: "grey", shape: "ring", text: "stopped" });
                callback(null, { success: true, message: "Server stopped" });
            }
        };

        // Handle input messages (lifecycle commands + tool responses).
        node.on('input', function (msg, send, done)
        {
            // Tool responses are consumed by executeToolFlow's listener; ignore here.
            if (msg.topic === 'mcp-tool-response')
            {
                if (done) done();
                return;
            }

            const command = msg.topic || (msg.payload && msg.payload.command);

            switch (command)
            {
                case 'start':
                    node.startServer();
                    break;

                case 'stop':
                    node.stopServer();
                    break;

                case 'restart':
                    node.stopServer(() =>
                    {
                        setTimeout(() => node.startServer(), 1000);
                    });
                    break;

                case 'status':
                    msg.payload = {
                        serverId: node.serverId,
                        serverName: node.serverName,
                        isRunning: node.isRunning,
                        port: node.serverPort,
                        toolCount: toolRegistry.keys().length
                    };
                    node.send(msg);
                    break;

                default:
                    // Unknown command: nothing to do.
                    break;
            }

            if (done) done();
        });

        // Auto-start if configured.
        if (node.autoStart)
        {
            setTimeout(() => node.startServer(), 1000);
        }

        // Cleanup on (re)deploy / shutdown. Node-RED 1.x+ close signature.
        node.on('close', function (removed, done)
        {
            // The second arg is the done callback when the runtime passes "removed".
            if (typeof removed === 'function')
            {
                done = removed;
            }
            if (node.isRunning)
            {
                node.stopServer(() => done());
            } else
            {
                done();
            }
        });
    }

    RED.nodes.registerType("mcp-flow-server", MCPFlowServerNode);

    // Bridge the tool-registry node events into the global registry.
    RED.events.on('mcp-tool-register', (toolDef) =>
    {
        toolRegistry.set(toolDef.name, toolDef);
    });

    RED.events.on('mcp-tool-unregister', (toolName) =>
    {
        toolRegistry.del(toolName);
    });

    // Admin endpoint to list running flow servers (auth-protected).
    RED.httpAdmin.get("/mcp-flow-servers", RED.auth.needsPermission("mcp-flow-server.read"), function (req, res)
    {
        const servers = [];
        serverInstances.keys().forEach(key =>
        {
            const server = serverInstances.get(key);
            if (server)
            {
                servers.push({
                    serverId: key,
                    serverName: server.serverName,
                    isRunning: server.isRunning,
                    port: server.port,
                    startTime: server.startTime,
                    toolCount: toolRegistry.keys().length
                });
            }
        });
        res.json({ servers });
    });
};
