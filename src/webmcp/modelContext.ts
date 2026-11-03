/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import type {
  EcctrlModelContext,
  PeerChatMessage,
  WebMCPBridgeOptions,
  WebMCPCallRecord,
  WebMCPProvideContextOptions,
  WebMCPToolDefinition,
  WebMCPToolDescriptor,
  WebMCPToolRegistrationOptions,
} from "./types";

let callSeq = 1;

class EcctrlModelContextHost extends EventTarget implements EcctrlModelContext {
  private toolsMap = new Map<string, WebMCPToolDefinition<any, any>>();
  private nativeTargets: Array<Record<string, unknown>> = [];
  public readonly isPolyfill: boolean;

  constructor(nativeTargets: Array<Record<string, unknown>>) {
    super();
    this.nativeTargets = nativeTargets;
    this.isPolyfill = nativeTargets.length === 0;
  }

  private emitChange(): void {
    this.dispatchEvent(new CustomEvent("toolchange"));
  }

  public async registerTool<TInput = Record<string, unknown>, TOutput = unknown>(
    tool: WebMCPToolDefinition<TInput, TOutput>,
    options?: WebMCPToolRegistrationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) return;

    const wrappedExecute = async (rawInput: TInput) => {
      return this.executeTool(
        tool.name,
        (rawInput ?? {}) as Record<string, unknown>,
        "browser-webmcp"
      );
    };

    this.toolsMap.set(tool.name, tool);

    // Forward to native browser WebMCP host(s) if available (Chrome 146+ / Edge)
    for (const nativeCtx of this.nativeTargets) {
      try {
        const reg = nativeCtx.registerTool as
          | ((t: unknown, o?: unknown) => Promise<unknown> | void)
          | undefined;
        if (typeof reg === "function") {
          await reg.call(
            nativeCtx,
            {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              execute: wrappedExecute,
            },
            options
          );
        }
      } catch {
        // Ignore duplicate/unsupported native registration quirks
      }
    }

    if (options?.signal) {
      const onAbort = () => {
        void this.unregisterTool(tool.name);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    this.emitChange();
  }

  public async unregisterTool(name: string): Promise<void> {
    if (!this.toolsMap.delete(name)) return;
    for (const nativeCtx of this.nativeTargets) {
      try {
        const unreg = nativeCtx.unregisterTool as
          | ((n: string) => Promise<unknown> | void)
          | undefined;
        if (typeof unreg === "function") {
          await unreg.call(nativeCtx, name);
        }
      } catch {
        // Ignore
      }
    }
    this.emitChange();
  }

  public async provideContext(options: WebMCPProvideContextOptions): Promise<void> {
    const tools = options.tools ?? [];
    for (const tool of tools) {
      await this.registerTool(tool);
    }
  }

  public async clearContext(): Promise<void> {
    this.toolsMap.clear();
    for (const nativeCtx of this.nativeTargets) {
      try {
        const clr = nativeCtx.clearContext as (() => Promise<unknown> | void) | undefined;
        if (typeof clr === "function") {
          await clr.call(nativeCtx);
        }
      } catch {
        // Ignore
      }
    }
    this.emitChange();
  }

  public async getTools(): Promise<WebMCPToolDescriptor[]> {
    const list: WebMCPToolDescriptor[] = [];
    this.toolsMap.forEach((t) => {
      list.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      });
    });
    return list;
  }

  public async executeTool(
    name: string,
    input: Record<string, unknown> = {},
    caller = "webmcp"
  ): Promise<unknown> {
    const tool = this.toolsMap.get(name);
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const id = `wmcp_${callSeq++}`;

    if (!tool) {
      const errMsg = `Unknown WebMCP tool: "${name}"`;
      const record: WebMCPCallRecord = {
        id,
        name,
        caller,
        args: input,
        ok: false,
        error: errMsg,
        durationMs: 0,
        timestamp: Date.now(),
      };
      this.dispatchEvent(new CustomEvent("toolresult", { detail: record }));
      throw new Error(errMsg);
    }

    try {
      const result = await tool.execute(input, { caller });
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
      const record: WebMCPCallRecord = {
        id,
        name,
        caller,
        args: input,
        ok: true,
        result,
        durationMs: Math.round(elapsed * 10) / 10,
        timestamp: Date.now(),
      };
      this.dispatchEvent(new CustomEvent("toolresult", { detail: record }));
      return result;
    } catch (err) {
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
      const errorText = err instanceof Error ? err.message : String(err);
      const record: WebMCPCallRecord = {
        id,
        name,
        caller,
        args: input,
        ok: false,
        error: errorText,
        durationMs: Math.round(elapsed * 10) / 10,
        timestamp: Date.now(),
      };
      this.dispatchEvent(new CustomEvent("toolresult", { detail: record }));
      throw err;
    }
  }
}

let singletonHost: EcctrlModelContext | null = null;

/**
 * Ensures a spec-compliant W3C WebMCP `ModelContext` is available on `document.modelContext`,
 * `navigator.modelContext`, and `window.ecctrlWebMCP` (wrapping native browser WebMCP when present).
 */
export function ensureWebMCPContext(): EcctrlModelContext {
  if (singletonHost) return singletonHost;

  if (typeof window === "undefined") {
    singletonHost = new EcctrlModelContextHost([]);
    return singletonHost;
  }

  if (window.ecctrlWebMCP) {
    singletonHost = window.ecctrlWebMCP;
    return singletonHost;
  }

  const nativeTargets: Array<Record<string, unknown>> = [];
  const docCtx = (document as unknown as { modelContext?: Record<string, unknown> })
    .modelContext;
  const navCtx = (navigator as unknown as { modelContext?: Record<string, unknown> })
    .modelContext;

  if (docCtx && !(docCtx instanceof EcctrlModelContextHost)) {
    nativeTargets.push(docCtx);
  }
  if (navCtx && navCtx !== docCtx && !(navCtx instanceof EcctrlModelContextHost)) {
    nativeTargets.push(navCtx);
  }

  const host = new EcctrlModelContextHost(nativeTargets);
  singletonHost = host;
  window.ecctrlWebMCP = host;

  if (!docCtx) {
    try {
      Object.defineProperty(document, "modelContext", {
        value: host,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Ignore read-only host descriptor
    }
  }

  if (!navCtx) {
    try {
      Object.defineProperty(navigator, "modelContext", {
        value: host,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Ignore read-only host descriptor
    }
  }

  return host;
}

/**
 * Connects the browser's `ModelContext` registry to a local Vite / HTTP Streamable MCP bridge
 * via standard Server-Sent Events (`EventSource`) and `fetch` — zero COOP/COEP or WebSocket ports needed.
 */
export function connectWebMCPBridge(options: WebMCPBridgeOptions = {}): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }

  const prefix = (options.endpointPrefix ?? "/api/webmcp").replace(/\/+$/, "");
  const ctx = ensureWebMCPContext();
  const peerId = `tab_${Math.random().toString(36).slice(2, 10)}`;
  let disposed = false;

  const pushToolsToBridge = async () => {
    if (disposed) return;
    try {
      const tools = await ctx.getTools();
      await fetch(`${prefix}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId, tools }),
      });
    } catch {
      // Bridge may not be mounted on static production hosts; fail silently
    }
  };

  const onToolChange = () => {
    void pushToolsToBridge();
  };

  const onToolResult = (e: Event) => {
    const detail = (e as CustomEvent<WebMCPCallRecord>).detail;
    if (detail) options.onToolCall?.(detail);
  };

  ctx.addEventListener("toolchange", onToolChange);
  ctx.addEventListener("toolresult", onToolResult);

  const es = new EventSource(`${prefix}/events?peerId=${encodeURIComponent(peerId)}`);

  es.onopen = () => {
    if (disposed) return;
    options.onStatusChange?.(true);
    void pushToolsToBridge();
  };

  es.onerror = () => {
    if (disposed) return;
    options.onStatusChange?.(false);
  };

  es.addEventListener("init", (ev) => {
    try {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        messages?: PeerChatMessage[];
      };
      if (payload.messages && payload.messages.length > 0) {
        const latest = payload.messages[payload.messages.length - 1];
        options.onChatMessage?.(latest, payload.messages);
      }
      void pushToolsToBridge();
    } catch {
      // Ignore malformed init
    }
  });

  es.addEventListener("chat", (ev) => {
    try {
      const msg = JSON.parse((ev as MessageEvent).data) as PeerChatMessage;
      options.onChatMessage?.(msg);
    } catch {
      // Ignore
    }
  });

  es.addEventListener("call", (ev) => {
    void (async () => {
      let callId = "";
      try {
        const req = JSON.parse((ev as MessageEvent).data) as {
          callId: string;
          name: string;
          args?: Record<string, unknown>;
          caller?: string;
        };
        callId = req.callId;
        const result = await ctx.executeTool(
          req.name,
          req.args ?? {},
          req.caller ?? "mcp-peer"
        );
        await fetch(`${prefix}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId, ok: true, result }),
        });
      } catch (err) {
        if (callId) {
          const error = err instanceof Error ? err.message : String(err);
          await fetch(`${prefix}/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callId, ok: false, error }),
          }).catch(() => {});
        }
      }
    })();
  });

  return () => {
    disposed = true;
    ctx.removeEventListener("toolchange", onToolChange);
    ctx.removeEventListener("toolresult", onToolResult);
    es.close();
    options.onStatusChange?.(false);
  };
}

/**
 * Posts a peer chat message to the shared WebMCP relay (falling back to local return if offline).
 */
export async function postPeerChatMessage(
  input: {
    sender: "human" | "agent" | "system";
    name: string;
    text: string;
    context?: PeerChatMessage["context"];
  },
  endpointPrefix = "/api/webmcp"
): Promise<PeerChatMessage> {
  const prefix = endpointPrefix.replace(/\/+$/, "");
  try {
    const res = await fetch(`${prefix}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = (await res.json()) as { message: PeerChatMessage };
      return data.message;
    }
  } catch {
    // Offline fallback
  }
  return {
    id: `local_${Date.now()}`,
    sender: input.sender,
    name: input.name,
    text: input.text,
    timestamp: Date.now(),
    context: input.context,
  };
}
