import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureWebMCPContext,
  postPeerChatMessage,
  type WebMCPToolDescriptor,
} from "../../src/webmcp";
import { usePeerStore } from "./usePeerStore";

export function PeerCommsHUD() {
  const bridgeConnected = usePeerStore((s) => s.bridgeConnected);
  const panelOpen = usePeerStore((s) => s.panelOpen);
  const activeTab = usePeerStore((s) => s.activeTab);
  const messages = usePeerStore((s) => s.messages);
  const toolFeed = usePeerStore((s) => s.toolFeed);
  const setPanelOpen = usePeerStore((s) => s.setPanelOpen);
  const setActiveTab = usePeerStore((s) => s.setActiveTab);
  const upsertMessages = usePeerStore((s) => s.upsertMessages);

  const [draft, setDraft] = useState("");
  const [registeredTools, setRegisteredTools] = useState<WebMCPToolDescriptor[]>([]);
  const [copiedMcp, setCopiedMcp] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshTools = useCallback(async () => {
    const ctx = ensureWebMCPContext();
    const list = await ctx.getTools();
    setRegisteredTools(list);
  }, []);

  useEffect(() => {
    const ctx = ensureWebMCPContext();
    void refreshTools();
    const onChange = () => void refreshTools();
    ctx.addEventListener("toolchange", onChange);
    return () => ctx.removeEventListener("toolchange", onChange);
  }, [refreshTools]);

  // Auto-scroll chat feed when messages or tool calls arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, toolFeed.length, panelOpen, activeTab]);

  // Global [Enter] shortcut to focus Peer Chat when playing
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) {
        return;
      }
      e.preventDefault();
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      setPanelOpen(true);
      setActiveTab("chat");
      setTimeout(() => inputRef.current?.focus(), 10);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [setActiveTab, setPanelOpen]);

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) {
        inputRef.current?.blur();
        return;
      }
      setDraft("");
      const context = usePeerStore.getState().getPlayerContextFn?.();
      const saved = await postPeerChatMessage({
        sender: "human",
        name: "You",
        text: trimmed,
        context,
      });
      upsertMessages(saved);
    },
    [draft, upsertMessages]
  );

  const copyMcpEndpoint = useCallback(() => {
    const url = `${window.location.origin}/mcp`;
    void navigator.clipboard?.writeText(url);
    setCopiedMcp(true);
    setTimeout(() => setCopiedMcp(false), 1800);
  }, []);

  const runQuickTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      try {
        await ensureWebMCPContext().executeTool(name, args, "local-ui");
      } catch (err) {
        console.error(err);
      }
    },
    []
  );

  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        style={{
          position: "fixed",
          right: 14,
          bottom: 14,
          zIndex: 45,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 13px",
          borderRadius: 999,
          border: "1px solid rgba(52, 211, 153, 0.45)",
          background: "rgba(15, 23, 42, 0.88)",
          backdropFilter: "blur(10px)",
          color: "#f8fafc",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: bridgeConnected ? "#34d399" : "#38bdf8",
          }}
        />
        <span>Peer Chat & WebMCP ({registeredTools.length}) [Enter]</span>
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 14,
        bottom: 14,
        width: 348,
        maxWidth: "calc(100vw - 28px)",
        zIndex: 45,
        display: "flex",
        flexDirection: "column",
        borderRadius: 14,
        background: "rgba(15, 23, 42, 0.88)",
        border: "1px solid rgba(148, 163, 184, 0.26)",
        backdropFilter: "blur(12px)",
        boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
        color: "#f8fafc",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        overflow: "hidden",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          borderBottom: "1px solid rgba(148, 163, 184, 0.18)",
          background: "rgba(30, 41, 59, 0.65)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            title={
              bridgeConnected
                ? "Connected to /mcp Streamable HTTP + document.modelContext"
                : "Browser document.modelContext active"
            }
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: bridgeConnected ? "#34d399" : "#38bdf8",
              boxShadow: bridgeConnected
                ? "0 0 8px #34d399"
                : "0 0 8px #38bdf8",
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.01em" }}>
            Peer WebMCP
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            type="button"
            onClick={() => setActiveTab("chat")}
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              border: "none",
              background:
                activeTab === "chat" ? "rgba(52, 211, 153, 0.22)" : "transparent",
              color: activeTab === "chat" ? "#6ee7b7" : "#94a3b8",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Chat
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("tools")}
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              border: "none",
              background:
                activeTab === "tools" ? "rgba(56, 189, 248, 0.22)" : "transparent",
              color: activeTab === "tools" ? "#7dd3fc" : "#94a3b8",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Tools ({registeredTools.length})
          </button>
          <button
            type="button"
            onClick={copyMcpEndpoint}
            title="Copy Streamable HTTP MCP URL for any AI client"
            style={{
              padding: "3px 7px",
              borderRadius: 6,
              border: "1px solid rgba(148, 163, 184, 0.25)",
              background: "rgba(15, 23, 42, 0.6)",
              color: copiedMcp ? "#4ade80" : "#cbd5e1",
              fontSize: 10.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {copiedMcp ? "Copied!" : "/mcp"}
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            title="Minimize"
            style={{
              padding: "2px 6px",
              borderRadius: 6,
              border: "none",
              background: "transparent",
              color: "#94a3b8",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            –
          </button>
        </div>
      </div>

      {activeTab === "chat" ? (
        <>
          {/* Live Peer Chat + Tool Feed */}
          <div
            ref={scrollRef}
            style={{
              height: 195,
              overflowY: "auto",
              padding: "8px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              userSelect: "text",
            }}
          >
            {messages.map((m) => {
              const isHuman = m.sender === "human";
              const isSystem = m.sender === "system";
              return (
                <div
                  key={m.id}
                  style={{
                    alignSelf: isSystem
                      ? "center"
                      : isHuman
                        ? "flex-end"
                        : "flex-start",
                    maxWidth: isSystem ? "96%" : "86%",
                    padding: isSystem ? "4px 8px" : "6px 9px",
                    borderRadius: 9,
                    background: isSystem
                      ? "rgba(30, 41, 59, 0.7)"
                      : isHuman
                        ? "rgba(14, 116, 144, 0.45)"
                        : "rgba(6, 95, 70, 0.48)",
                    border: isSystem
                      ? "1px solid rgba(148, 163, 184, 0.18)"
                      : isHuman
                        ? "1px solid rgba(56, 189, 248, 0.4)"
                        : "1px solid rgba(52, 211, 153, 0.42)",
                    fontSize: isSystem ? 11 : 12,
                    lineHeight: 1.35,
                  }}
                >
                  {!isSystem && (
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: isHuman ? "#7dd3fc" : "#6ee7b7",
                        marginBottom: 2,
                      }}
                    >
                      {m.name}
                      {m.context?.aimTarget && (
                        <span style={{ color: "#94a3b8", fontWeight: 500 }}>
                          {" "}
                          • ⌖ {m.context.aimTarget.split(" (")[0]}
                        </span>
                      )}
                    </div>
                  )}
                  <div style={{ color: isSystem ? "#cbd5e1" : "#f8fafc" }}>
                    {m.text}
                  </div>
                </div>
              );
            })}

            {toolFeed.slice(-4).map((rec) => (
              <div
                key={rec.id}
                style={{
                  alignSelf: "stretch",
                  padding: "3px 7px",
                  borderRadius: 6,
                  background: "rgba(30, 41, 59, 0.55)",
                  borderLeft: `2px solid ${rec.ok ? "#34d399" : "#fb7185"}`,
                  fontSize: 10.5,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "#cbd5e1",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  ⚡ {rec.name}
                </span>
                <span style={{ color: "#94a3b8", flexShrink: 0 }}>
                  {rec.durationMs}ms
                </span>
              </div>
            ))}
          </div>

          {/* Declarative W3C WebMCP Chat Form */}
          <form
            onSubmit={(e) => void handleSend(e)}
            {...({
              "tool-name": "send_human_peer_chat",
              "tool-description": "Send a peer chat message into the shared 3D SimReady world",
            } as React.FormHTMLAttributes<HTMLFormElement>)}
            style={{
              display: "flex",
              gap: 6,
              padding: "7px 8px",
              borderTop: "1px solid rgba(148, 163, 184, 0.18)",
              background: "rgba(15, 23, 42, 0.9)",
            }}
          >
            <input
              ref={inputRef}
              name="message"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Prevent WASD / Space / F / 1-5 from triggering game controls while typing!
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.currentTarget.blur();
                }
              }}
              onKeyUp={(e) => e.stopPropagation()}
              placeholder="Chat with your AI peer... [Enter]"
              style={{
                flex: 1,
                padding: "6px 9px",
                borderRadius: 8,
                border: "1px solid rgba(148, 163, 184, 0.3)",
                background: "rgba(30, 41, 59, 0.85)",
                color: "#f8fafc",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "6px 11px",
                borderRadius: 8,
                border: "1px solid rgba(52, 211, 153, 0.5)",
                background: "rgba(16, 185, 129, 0.25)",
                color: "#6ee7b7",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Send
            </button>
          </form>
        </>
      ) : (
        <div
          style={{
            height: 236,
            overflowY: "auto",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 7,
          }}
        >
          {/* Quick 1-Click WebMCP Actions */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            <button
              type="button"
              onClick={() =>
                void runQuickTool("rig_simready_vehicle", {
                  mode: "car",
                  assetPreset: "pallet",
                })
              }
              style={quickBtnStyle}
            >
              + Rig Pallet Car
            </button>
            <button
              type="button"
              onClick={() =>
                void runQuickTool("rig_simready_vehicle", {
                  mode: "drone",
                  assetPreset: "sensor_pod",
                })
              }
              style={quickBtnStyle}
            >
              + Rig USDC Drone
            </button>
            <button
              type="button"
              onClick={() =>
                void runQuickTool("pilot_vehicle", {
                  vehicleId: "latest",
                  action: "circle_left",
                  durationSeconds: 6,
                })
              }
              style={quickBtnStyle}
            >
              Peer Drive Latest
            </button>
            <button
              type="button"
              onClick={() =>
                void runQuickTool("set_world_physics", { gravityPreset: "moon" })
              }
              style={quickBtnStyle}
            >
              Moon Gravity
            </button>
            <button
              type="button"
              onClick={() =>
                void runQuickTool("set_world_physics", {
                  gravityPreset: "default_field",
                })
              }
              style={quickBtnStyle}
            >
              Default Gravity
            </button>
          </div>

          <div
            style={{
              fontSize: 10.5,
              color: "#94a3b8",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            MCP HTTP: {window.location.origin}/mcp
          </div>

          {registeredTools.map((t) => (
            <div
              key={t.name}
              style={{
                padding: "6px 8px",
                borderRadius: 7,
                background: "rgba(30, 41, 59, 0.65)",
                border: "1px solid rgba(148, 163, 184, 0.16)",
              }}
            >
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: "#7dd3fc",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {t.name}
              </div>
              <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 2 }}>
                {t.description}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const quickBtnStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid rgba(56, 189, 248, 0.35)",
  background: "rgba(14, 116, 144, 0.25)",
  color: "#e0f2fe",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
