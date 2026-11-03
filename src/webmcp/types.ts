/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

export interface WebMCPJsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: (string | number | boolean)[];
  items?: WebMCPJsonSchemaProperty;
  properties?: Record<string, WebMCPJsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface WebMCPInputSchema {
  type: "object";
  properties?: Record<string, WebMCPJsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface WebMCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface WebMCPToolDescriptor {
  name: string;
  description: string;
  inputSchema: WebMCPInputSchema;
  annotations?: WebMCPToolAnnotations;
}

export interface WebMCPToolDefinition<TInput = Record<string, unknown>, TOutput = unknown>
  extends WebMCPToolDescriptor {
  execute: (input: TInput, context?: { caller?: string }) => Promise<TOutput> | TOutput;
}

export interface WebMCPToolRegistrationOptions {
  signal?: AbortSignal;
}

export interface WebMCPProvideContextOptions {
  tools?: WebMCPToolDefinition<any, any>[];
}

export interface WebMCPCallRecord {
  id: string;
  name: string;
  caller: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  timestamp: number;
}

export interface PeerChatMessage {
  id: string;
  sender: "human" | "agent" | "system";
  name: string;
  text: string;
  timestamp: number;
  context?: {
    playerPos?: [number, number, number];
    activeController?: string;
    aimTarget?: string | null;
  };
}

/**
 * W3C WebMCP `ModelContext` interface compatible with both `document.modelContext` (2026 draft)
 * and `navigator.modelContext` (Chromium 146+ / MCP-B).
 */
export interface EcctrlModelContext extends EventTarget {
  registerTool: <TInput = Record<string, unknown>, TOutput = unknown>(
    tool: WebMCPToolDefinition<TInput, TOutput>,
    options?: WebMCPToolRegistrationOptions
  ) => Promise<void>;
  unregisterTool: (name: string) => Promise<void>;
  provideContext: (options: WebMCPProvideContextOptions) => Promise<void>;
  clearContext: () => Promise<void>;
  getTools: () => Promise<WebMCPToolDescriptor[]>;
  executeTool: (
    name: string,
    input?: Record<string, unknown>,
    caller?: string
  ) => Promise<unknown>;
  readonly isPolyfill: boolean;
}

export interface WebMCPBridgeOptions {
  /** Base endpoint prefix for the Vite/HTTP WebMCP relay. @default "/api/webmcp" */
  endpointPrefix?: string;
  /** Callback fired when initial or live peer chat messages arrive. */
  onChatMessage?: (message: PeerChatMessage, allMessages?: PeerChatMessage[]) => void;
  /** Callback fired when bridge connection state changes. */
  onStatusChange?: (connected: boolean) => void;
  /** Callback fired whenever any WebMCP tool finishes executing. */
  onToolCall?: (record: WebMCPCallRecord) => void;
}

declare global {
  interface Document {
    modelContext?: EcctrlModelContext;
  }
  interface Navigator {
    modelContext?: EcctrlModelContext;
  }
  interface Window {
    ecctrlWebMCP?: EcctrlModelContext;
  }
}
