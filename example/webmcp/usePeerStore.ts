import { create } from "zustand";
import type { PeerChatMessage, WebMCPCallRecord } from "../../src/webmcp";

export type AutopilotAction =
  | "forward"
  | "reverse"
  | "circle_left"
  | "circle_right"
  | "hover_up"
  | "hover_spin"
  | "brake";

export interface AutopilotOrder {
  action: AutopilotAction;
  until: number;
}

export interface PeerBotState {
  targetPosition: [number, number, number];
  followPlayer: boolean;
  beamTarget: [number, number, number] | null;
  beamColor: string;
  beamUntil: number;
  speechText: string | null;
  speechSender: string;
  speechUntil: number;
}

export interface WorldSettingsPatch {
  pausedPhysics?: boolean;
  physicsDebug?: boolean;
  slowMotion?: number;
}

export interface PeerStoreState {
  bridgeConnected: boolean;
  panelOpen: boolean;
  activeTab: "chat" | "tools";
  messages: PeerChatMessage[];
  toolFeed: WebMCPCallRecord[];
  peerBot: PeerBotState;
  autopilots: Record<string, AutopilotOrder>;

  setWorldSettingsFn: ((patch: WorldSettingsPatch) => void) | null;
  resetSimReadyStagesFn: (() => void) | null;
  getPlayerContextFn: (() => PeerChatMessage["context"]) | null;

  setBridgeConnected: (connected: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  setActiveTab: (tab: "chat" | "tools") => void;
  upsertMessages: (incoming: PeerChatMessage | PeerChatMessage[]) => void;
  pushToolRecord: (record: WebMCPCallRecord) => void;

  commandPeerBot: (patch: {
    targetPosition?: [number, number, number];
    followPlayer?: boolean;
    beamTarget?: [number, number, number] | null;
    beamColor?: string;
    beamDurationMs?: number;
    speechText?: string;
    speechSender?: string;
    speechDurationMs?: number;
  }) => void;

  setAutopilot: (vehicleId: string, action: AutopilotAction, durationSeconds: number) => void;
  clearAutopilot: (vehicleId: string) => void;

  setWorldSettingsCallback: (fn: ((patch: WorldSettingsPatch) => void) | null) => void;
  setResetSimReadyStagesCallback: (fn: (() => void) | null) => void;
  setGetPlayerContextCallback: (
    fn: (() => PeerChatMessage["context"]) | null
  ) => void;
}

let speechExpireTimer: ReturnType<typeof setTimeout> | null = null;

export const usePeerStore = create<PeerStoreState>((set) => ({
  bridgeConnected: false,
  panelOpen: true,
  activeTab: "chat",
  messages: [],
  toolFeed: [],
  peerBot: {
    targetPosition: [2.6, 3.6, -58.5],
    followPlayer: true,
    beamTarget: null,
    beamColor: "#34d399",
    beamUntil: 0,
    speechText: "Peer Bot online — press [Enter] to chat!",
    speechSender: "AI Peer",
    speechUntil: Date.now() + 7000,
  },
  autopilots: {},

  setWorldSettingsFn: null,
  resetSimReadyStagesFn: null,
  getPlayerContextFn: null,

  setBridgeConnected: (bridgeConnected) => set({ bridgeConnected }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setActiveTab: (activeTab) => set({ activeTab }),

  upsertMessages: (incoming) =>
    set((state) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];
      const byId = new Map<string, PeerChatMessage>();
      for (const m of state.messages) byId.set(m.id, m);
      for (const m of list) byId.set(m.id, m);
      const merged = Array.from(byId.values()).sort(
        (a, b) => a.timestamp - b.timestamp
      );
      return { messages: merged.slice(-150) };
    }),

  pushToolRecord: (record) =>
    set((state) => ({
      toolFeed: [...state.toolFeed.slice(-29), record],
    })),

  commandPeerBot: (patch) => {
    if (patch.speechText) {
      if (speechExpireTimer) clearTimeout(speechExpireTimer);
      speechExpireTimer = setTimeout(() => {
        set((s) => ({
          peerBot: { ...s.peerBot, speechText: null, speechUntil: 0 },
        }));
      }, patch.speechDurationMs ?? 8000);
    }
    set((state) => {
      const now = Date.now();
      return {
        peerBot: {
          targetPosition: patch.targetPosition ?? state.peerBot.targetPosition,
          followPlayer:
            patch.followPlayer !== undefined
              ? patch.followPlayer
              : state.peerBot.followPlayer,
          beamTarget:
            patch.beamTarget !== undefined
              ? patch.beamTarget
              : state.peerBot.beamTarget,
          beamColor: patch.beamColor ?? state.peerBot.beamColor,
          beamUntil:
            patch.beamTarget !== undefined && patch.beamTarget !== null
              ? now + (patch.beamDurationMs ?? 1600)
              : state.peerBot.beamUntil,
          speechText:
            patch.speechText !== undefined
              ? patch.speechText
              : state.peerBot.speechText,
          speechSender: patch.speechSender ?? state.peerBot.speechSender,
          speechUntil:
            patch.speechText !== undefined
              ? now + (patch.speechDurationMs ?? 8000)
              : state.peerBot.speechUntil,
        },
      };
    });
  },

  setAutopilot: (vehicleId, action, durationSeconds) =>
    set((state) => ({
      autopilots: {
        ...state.autopilots,
        [vehicleId]: {
          action,
          until: Date.now() + Math.max(0.5, durationSeconds) * 1000,
        },
      },
    })),

  clearAutopilot: (vehicleId) =>
    set((state) => {
      const next = { ...state.autopilots };
      delete next[vehicleId];
      return { autopilots: next };
    }),

  setWorldSettingsCallback: (setWorldSettingsFn) => set({ setWorldSettingsFn }),
  setResetSimReadyStagesCallback: (resetSimReadyStagesFn) =>
    set({ resetSimReadyStagesFn }),
  setGetPlayerContextCallback: (getPlayerContextFn) =>
    set({ getPlayerContextFn }),
}));
