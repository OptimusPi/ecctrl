/*!
 * Ecctrl WebMCP + Streamable HTTP MCP Peer Bridge Plugin for Vite
 * Exposes `http://localhost:5173/mcp` (JSON-RPC 2.0 MCP) + `/api/webmcp/*` SSE/REST relay
 * bridging external AI agents and browser `document.modelContext` / `navigator.modelContext` as live peers.
 */

const FALLBACK_PEER_TOOLS = [
  {
    name: "peer_chat",
    description:
      "Send a live chat message into the 3D Ecctrl + SimReady world as an AI peer (also displays above your 3D Peer Bot avatar and optionally moves/pings in 3D space).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message text to say to your human peer." },
        senderName: { type: "string", description: "Display name (default: 'AI Peer')." },
        moveNearPlayer: {
          type: "boolean",
          description: "Fly your 3D Peer Bot over near the player when speaking.",
        },
        pingPosition: {
          type: "array",
          items: { type: "number" },
          description: "Optional [x, y, z] world coordinate to point your 3D laser beam at.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "read_peer_chat",
    description:
      "Read recent peer chat messages between you and the human player, along with live player coordinates and crosshair target.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max recent messages to return (default 30)." },
      },
    },
  },
];

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
    ...extraHeaders,
  });
  res.end(payload);
}

export function viteWebMcpPlugin() {
  /** @type {Map<string, { peerId: string, res: import('node:http').ServerResponse, connectedAt: number }>} */
  const browserClients = new Map();
  /** @type {Array<{ name: string, description: string, inputSchema: object }>} */
  let latestBrowserTools = [];
  /** @type {Array<{ id: string, sender: string, name: string, text: string, timestamp: number, context?: object }>} */
  const peerChatLog = [
    {
      id: "msg_boot",
      sender: "system",
      name: "WebMCP Bridge",
      text: "Peer bridge live on /mcp & document.modelContext. Press [Enter] to chat or build together!",
      timestamp: Date.now(),
    },
  ];
  /** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
  const pendingCalls = new Map();
  let seq = 1;

  function broadcastSse(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [peerId, client] of browserClients.entries()) {
      try {
        client.res.write(frame);
      } catch {
        browserClients.delete(peerId);
      }
    }
  }

  function appendChatMessage({ sender = "agent", name = "AI Peer", text, context }) {
    const msg = {
      id: `msg_${Date.now()}_${seq++}`,
      sender,
      name,
      text: String(text ?? "").trim(),
      timestamp: Date.now(),
      ...(context ? { context } : {}),
    };
    peerChatLog.push(msg);
    if (peerChatLog.length > 200) {
      peerChatLog.splice(0, peerChatLog.length - 200);
    }
    // Log to Vite console so terminal/log readers see live peer chat immediately
    // eslint-disable-next-line no-console
    console.log(`[WebMCP PeerChat] (${msg.sender}) ${msg.name}: ${msg.text}`);
    broadcastSse("chat", msg);
    return msg;
  }

  function getActiveBrowserClient() {
    let newest = null;
    for (const client of browserClients.values()) {
      if (!newest || client.connectedAt >= newest.connectedAt) {
        newest = client;
      }
    }
    return newest;
  }

  function getCombinedTools() {
    const byName = new Map();
    for (const t of FALLBACK_PEER_TOOLS) byName.set(t.name, t);
    for (const t of latestBrowserTools) byName.set(t.name, t);
    return Array.from(byName.values());
  }

  function dispatchBrowserToolCall(name, args, caller = "mcp-peer", timeoutMs = 12000) {
    const active = getActiveBrowserClient();
    if (!active) {
      return Promise.reject(
        new Error(
          "No active browser tab connected to WebMCP bridge yet. Open http://localhost:5173/ in your browser."
        )
      );
    }

    const callId = `rpc_${Date.now()}_${seq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        reject(new Error(`Timed out waiting for browser WebMCP tool "${name}"`));
      }, timeoutMs);

      pendingCalls.set(callId, { resolve, reject, timer });
      try {
        active.res.write(
          `event: call\ndata: ${JSON.stringify({ callId, name, args, caller })}\n\n`
        );
      } catch (err) {
        clearTimeout(timer);
        pendingCalls.delete(callId);
        browserClients.delete(active.peerId);
        reject(err);
      }
    });
  }

  async function handleMcpJsonRpc(rpc) {
    if (!rpc || typeof rpc !== "object") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request" },
      };
    }

    const { id, method, params } = rpc;

    // Notifications have no `id`
    if (id === undefined) {
      return null;
    }

    try {
      if (method === "initialize") {
        const clientProto =
          params && typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-03-26";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientProto,
            capabilities: {
              tools: { listChanged: true },
              resources: {},
            },
            serverInfo: {
              name: "ecctrl-simready-webmcp",
              version: "2.0.2",
            },
            instructions:
              "Live peer-to-peer WebMCP bridge into the running 3D Ecctrl + Rapier + NVIDIA SimReady OpenUSD playground. Use get_world_state and read_peer_chat to see what your human peer is doing, peer_chat to talk in-game, and spawn_simready_prop / rig_simready_vehicle / pilot_vehicle / weld_bodies / manipulate_body / set_world_physics to co-build and play together in real time.",
          },
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }

      if (method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: getCombinedTools(),
          },
        };
      }

      if (method === "resources/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              {
                uri: "webmcp://peer-chat",
                name: "Live Peer Chat Log",
                description: "Bidirectional chat log between human player and AI peer(s).",
                mimeType: "application/json",
              },
              {
                uri: "webmcp://tools",
                name: "Registered Browser WebMCP Tools",
                description: "Tools currently registered on document.modelContext.",
                mimeType: "application/json",
              },
            ],
          },
        };
      }

      if (method === "resources/read") {
        const uri = params?.uri;
        const payload =
          uri === "webmcp://tools"
            ? { tools: getCombinedTools(), connectedBrowserTabs: browserClients.size }
            : { messages: peerChatLog, connectedBrowserTabs: browserClients.size };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: uri || "webmcp://peer-chat",
                mimeType: "application/json",
                text: JSON.stringify(payload, null, 2),
              },
            ],
          },
        };
      }

      if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = (params?.arguments && typeof params.arguments === "object")
          ? params.arguments
          : {};

        if (!toolName || typeof toolName !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing tool name in tools/call" },
          };
        }

        // Hybrid handling for peer_chat so messages always persist on the server AND animate in 3D if tab is open
        if (toolName === "peer_chat") {
          const chatEntry = appendChatMessage({
            sender: "agent",
            name: typeof toolArgs.senderName === "string" && toolArgs.senderName.trim()
              ? toolArgs.senderName.trim()
              : "AI Peer",
            text: String(toolArgs.message ?? ""),
          });

          let sceneReaction = null;
          if (getActiveBrowserClient()) {
            try {
              sceneReaction = await dispatchBrowserToolCall(
                "peer_chat",
                { ...toolArgs, _alreadyLoggedId: chatEntry.id },
                "mcp-peer",
                5000
              );
            } catch {
              // Message is already delivered to peerChatLog
            }
          }

          const out = {
            delivered: true,
            message: chatEntry,
            connectedBrowserTabs: browserClients.size,
            ...(sceneReaction ? { scene: sceneReaction } : {}),
          };
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
              structuredContent: out,
              isError: false,
            },
          };
        }

        if (toolName === "read_peer_chat") {
          const limit =
            typeof toolArgs.limit === "number" && toolArgs.limit > 0
              ? Math.min(200, Math.floor(toolArgs.limit))
              : 30;
          const recent = peerChatLog.slice(-limit);
          let livePlayer = null;
          if (getActiveBrowserClient()) {
            try {
              livePlayer = await dispatchBrowserToolCall(
                "read_peer_chat",
                { limit },
                "mcp-peer",
                4000
              );
            } catch {
              // Ignore if tab busy
            }
          }
          const out = {
            connectedBrowserTabs: browserClients.size,
            messages: recent,
            ...(livePlayer && typeof livePlayer === "object" ? { liveWorld: livePlayer } : {}),
          };
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
              structuredContent: out,
              isError: false,
            },
          };
        }

        const result = await dispatchBrowserToolCall(toolName, toolArgs, "mcp-peer");
        const safeStructured =
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : { value: result };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: safeStructured,
            isError: false,
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
        },
      };
    }
  }

  function attachMiddleware(middlewares) {
    middlewares.use(async (req, res, next) => {
      const rawUrl = req.url || "";
      const pathname = rawUrl.split("?")[0];

      if (pathname !== "/mcp" && !pathname.startsWith("/api/webmcp/")) {
        return next();
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
        });
        res.end();
        return;
      }

      // 1. Browser SSE event stream
      if (pathname === "/api/webmcp/events" && req.method === "GET") {
        const qs = new URL(rawUrl, "http://localhost").searchParams;
        const peerId = qs.get("peerId") || `tab_${seq++}`;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "X-Accel-Buffering": "no",
        });

        const client = { peerId, res, connectedAt: Date.now() };
        browserClients.set(peerId, client);

        res.write(
          `event: init\ndata: ${JSON.stringify({ peerId, messages: peerChatLog })}\n\n`
        );

        const hb = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            clearInterval(hb);
            browserClients.delete(peerId);
          }
        }, 15000);

        req.on("close", () => {
          clearInterval(hb);
          browserClients.delete(peerId);
        });
        return;
      }

      // 2. Browser registers its `document.modelContext` tool schemas
      if (pathname === "/api/webmcp/register" && req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          if (Array.isArray(body.tools)) {
            latestBrowserTools = body.tools;
          }
          sendJson(res, 200, { ok: true, count: latestBrowserTools.length });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err) });
        }
        return;
      }

      // 3. Browser returns tool execution result
      if (pathname === "/api/webmcp/result" && req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const pending = pendingCalls.get(body.callId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingCalls.delete(body.callId);
            if (body.ok) pending.resolve(body.result);
            else pending.reject(new Error(body.error || "WebMCP tool failed"));
          }
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err) });
        }
        return;
      }

      // 4. Peer chat REST endpoint
      if (pathname === "/api/webmcp/chat") {
        if (req.method === "GET") {
          sendJson(res, 200, {
            messages: peerChatLog,
            connectedBrowserTabs: browserClients.size,
          });
          return;
        }
        if (req.method === "POST") {
          try {
            const body = await readJsonBody(req);
            if (!body.text || !String(body.text).trim()) {
              sendJson(res, 400, { ok: false, error: "Empty message" });
              return;
            }
            const msg = appendChatMessage({
              sender: body.sender === "human" ? "human" : "agent",
              name: body.name || (body.sender === "human" ? "You" : "AI Peer"),
              text: String(body.text),
              context: body.context,
            });
            sendJson(res, 200, { ok: true, message: msg });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String(err) });
          }
          return;
        }
      }

      // 5. Standard MCP Streamable HTTP Endpoint (`/mcp`)
      if (pathname === "/mcp") {
        if (req.method === "DELETE") {
          res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
          res.end();
          return;
        }

        if (req.method === "GET") {
          const accept = String(req.headers.accept || "");
          if (accept.includes("text/event-stream")) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });
            res.write(": mcp-sse-open\n\n");
            const hb = setInterval(() => {
              try {
                res.write(": ping\n\n");
              } catch {
                clearInterval(hb);
              }
            }, 15000);
            req.on("close", () => clearInterval(hb));
            return;
          }

          sendJson(res, 200, {
            server: "ecctrl-simready-webmcp",
            protocol: "MCP Streamable HTTP + W3C WebMCP (document.modelContext)",
            mcpEndpoint: "/mcp",
            connectedBrowserTabs: browserClients.size,
            registeredTools: getCombinedTools().map((t) => t.name),
            recentChatCount: peerChatLog.length,
          });
          return;
        }

        if (req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (Array.isArray(payload)) {
              const responses = (
                await Promise.all(payload.map((item) => handleMcpJsonRpc(item)))
              ).filter(Boolean);
              if (responses.length === 0) {
                res.writeHead(202, { "Access-Control-Allow-Origin": "*" });
                res.end();
              } else {
                sendJson(res, 200, responses, { "Mcp-Session-Id": "ecctrl-peer-session" });
              }
              return;
            }

            const reply = await handleMcpJsonRpc(payload);
            if (!reply) {
              res.writeHead(202, {
                "Access-Control-Allow-Origin": "*",
                "Mcp-Session-Id": "ecctrl-peer-session",
              });
              res.end();
              return;
            }
            sendJson(res, 200, reply, { "Mcp-Session-Id": "ecctrl-peer-session" });
          } catch (err) {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: `Parse error: ${String(err)}` },
            });
          }
          return;
        }
      }

      next();
    });
  }

  return {
    name: "ecctrl-webmcp-bridge",
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}
