/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

export {
  ensureWebMCPContext,
  connectWebMCPBridge,
  postPeerChatMessage,
} from "./webmcp/modelContext";

export { useWebMCPTools, useWebMCPBridge } from "./webmcp/useWebMCP";

export type {
  WebMCPJsonSchemaProperty,
  WebMCPInputSchema,
  WebMCPToolAnnotations,
  WebMCPToolDescriptor,
  WebMCPToolDefinition,
  WebMCPToolRegistrationOptions,
  WebMCPProvideContextOptions,
  WebMCPCallRecord,
  PeerChatMessage,
  EcctrlModelContext,
  WebMCPBridgeOptions,
} from "./webmcp/types";
