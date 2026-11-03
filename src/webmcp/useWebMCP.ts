/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import { useEffect, useRef } from "react";
import { connectWebMCPBridge, ensureWebMCPContext } from "./modelContext";
import type { WebMCPBridgeOptions, WebMCPToolDefinition } from "./types";

/**
 * Registers an array of W3C WebMCP tools on `document.modelContext` / `navigator.modelContext`
 * with automatic `AbortController` cleanup on unmount and stable live-closure execution.
 */
export function useWebMCPTools(tools: WebMCPToolDefinition<any, any>[]): void {
  const latestToolsRef = useRef<Map<string, WebMCPToolDefinition<any, any>>>(
    new Map()
  );

  // Always point to latest closures without re-registering schemas every frame
  const map = new Map<string, WebMCPToolDefinition<any, any>>();
  for (const t of tools) {
    map.set(t.name, t);
  }
  latestToolsRef.current = map;

  const toolSignature = tools.map((t) => t.name).join("|");

  useEffect(() => {
    const ctx = ensureWebMCPContext();
    const abortController = new AbortController();

    for (const tool of latestToolsRef.current.values()) {
      void ctx.registerTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          execute: (input, context) => {
            const current = latestToolsRef.current.get(tool.name) ?? tool;
            return current.execute(input, context);
          },
        },
        { signal: abortController.signal }
      );
    }

    return () => {
      abortController.abort();
    };
  }, [toolSignature]);
}

/**
 * Connects the browser's `ModelContext` registry to the local `/api/webmcp` + `/mcp` HTTP Streamable MCP bridge.
 */
export function useWebMCPBridge(options: WebMCPBridgeOptions = {}): void {
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    return connectWebMCPBridge({
      endpointPrefix: optsRef.current.endpointPrefix,
      onChatMessage: (msg, all) => optsRef.current.onChatMessage?.(msg, all),
      onStatusChange: (ok) => optsRef.current.onStatusChange?.(ok),
      onToolCall: (rec) => optsRef.current.onToolCall?.(rec),
    });
  }, [options.endpointPrefix]);
}
