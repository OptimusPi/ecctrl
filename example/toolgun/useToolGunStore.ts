import { create } from "zustand";
import type {
  QuaternionTuple,
  SimReadyRigidBodyDesc,
  SimReadyUSDAsset,
  Vector3Tuple,
} from "../../src/simready";

export type ToolGunMode = "physgun" | "spawner" | "weld" | "rig" | "remove";

export type SpawnerPreset =
  | "pallet"
  | "sensor_pod"
  | "crate"
  | "drum"
  | "custom";

export type WeldVariant = "fixed" | "motor_hinge" | "free_hinge";
export type RigVariant = "car" | "drone";

export interface TargetReadout {
  key: string;
  name: string;
  primPath?: string;
  qCode?: string;
  mass?: number;
  frozen: boolean;
  isRiggedVehicle?: boolean;
  distance: number;
}

export interface SpawnedSimReadyProp {
  id: string;
  label: string;
  desc: SimReadyRigidBodyDesc;
  position: Vector3Tuple;
  quaternion: QuaternionTuple;
}

export interface RiggedSimReadyVehicleItem {
  id: `simveh:${string}`;
  label: string;
  mode: RigVariant;
  desc: SimReadyRigidBodyDesc;
  position: Vector3Tuple;
  rotation: Vector3Tuple;
}

export interface ToolGunStoreState {
  mode: ToolGunMode;
  spawnerPreset: SpawnerPreset;
  weldVariant: WeldVariant;
  rigVariant: RigVariant;
  pointerLocked: boolean;
  grabbing: boolean;
  pendingWeldLabel: string | null;
  target: TargetReadout | null;
  toast: string | null;
  customAsset: { filename: string; asset: SimReadyUSDAsset } | null;
  spawnedProps: SpawnedSimReadyProp[];
  riggedVehicles: RiggedSimReadyVehicleItem[];
  requestPointerLockFn: (() => void) | null;
  registerExternalWeldFn:
    | ((weld: {
        joint: unknown;
        body0Handle: number;
        body1Handle: number;
        localAnchor0: [number, number, number];
        localAnchor1: [number, number, number];
        color?: string;
      }) => void)
    | null;
  clearWeldsSignal: number;

  setMode: (mode: ToolGunMode) => void;
  cycleSubVariant: () => void;
  setSpawnerPreset: (preset: SpawnerPreset) => void;
  setWeldVariant: (variant: WeldVariant) => void;
  setRigVariant: (variant: RigVariant) => void;
  setPointerLocked: (locked: boolean) => void;
  setGrabbing: (grabbing: boolean) => void;
  setPendingWeldLabel: (label: string | null) => void;
  setTarget: (target: TargetReadout | null) => void;
  showToast: (msg: string) => void;
  setCustomAsset: (entry: { filename: string; asset: SimReadyUSDAsset }) => void;
  addSpawnedProp: (prop: SpawnedSimReadyProp) => void;
  removeSpawnedProp: (id: string) => void;
  addRiggedVehicle: (veh: RiggedSimReadyVehicleItem) => void;
  removeRiggedVehicle: (id: `simveh:${string}`) => void;
  clearAllToolGunItems: () => void;
  setRequestPointerLockFn: (fn: (() => void) | null) => void;
  setRegisterExternalWeldFn: (
    fn: ToolGunStoreState["registerExternalWeldFn"]
  ) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useToolGunStore = create<ToolGunStoreState>((set, get) => ({
  mode: "physgun",
  spawnerPreset: "pallet",
  weldVariant: "fixed",
  rigVariant: "car",
  pointerLocked: false,
  grabbing: false,
  pendingWeldLabel: null,
  target: null,
  toast: null,
  customAsset: null,
  spawnedProps: [],
  riggedVehicles: [],
  requestPointerLockFn: null,
  registerExternalWeldFn: null,
  clearWeldsSignal: 0,

  setMode: (mode) => set({ mode, pendingWeldLabel: null }),

  cycleSubVariant: () => {
    const s = get();
    if (s.mode === "spawner") {
      const order: SpawnerPreset[] = s.customAsset
        ? ["pallet", "sensor_pod", "crate", "drum", "custom"]
        : ["pallet", "sensor_pod", "crate", "drum"];
      const next = order[(order.indexOf(s.spawnerPreset) + 1) % order.length];
      set({ spawnerPreset: next });
    } else if (s.mode === "weld") {
      const order: WeldVariant[] = ["fixed", "motor_hinge", "free_hinge"];
      const next = order[(order.indexOf(s.weldVariant) + 1) % order.length];
      set({ weldVariant: next });
    } else if (s.mode === "rig") {
      set({ rigVariant: s.rigVariant === "car" ? "drone" : "car" });
    } else if (s.mode === "remove") {
      get().clearAllToolGunItems();
      get().showToast("Cleared all Tool Gun props, vehicles & welds");
    }
  },

  setSpawnerPreset: (spawnerPreset) => set({ spawnerPreset }),
  setWeldVariant: (weldVariant) => set({ weldVariant }),
  setRigVariant: (rigVariant) => set({ rigVariant }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setGrabbing: (grabbing) => set({ grabbing }),
  setPendingWeldLabel: (pendingWeldLabel) => set({ pendingWeldLabel }),

  setTarget: (target) => {
    const prev = get().target;
    if (!prev && !target) return;
    if (
      prev &&
      target &&
      prev.key === target.key &&
      prev.frozen === target.frozen &&
      Math.abs(prev.distance - target.distance) < 0.15
    ) {
      return;
    }
    set({ target });
  },

  showToast: (msg) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => {
      set({ toast: null });
    }, 2600);
  },

  setCustomAsset: (entry) =>
    set({
      customAsset: entry,
      mode: "spawner",
      spawnerPreset: "custom",
    }),

  addSpawnedProp: (prop) =>
    set((s) => ({ spawnedProps: [...s.spawnedProps, prop] })),

  removeSpawnedProp: (id) =>
    set((s) => ({
      spawnedProps: s.spawnedProps.filter((p) => p.id !== id),
    })),

  addRiggedVehicle: (veh) =>
    set((s) => ({ riggedVehicles: [...s.riggedVehicles, veh] })),

  removeRiggedVehicle: (id) =>
    set((s) => ({
      riggedVehicles: s.riggedVehicles.filter((v) => v.id !== id),
    })),

  clearAllToolGunItems: () =>
    set((s) => ({
      spawnedProps: [],
      riggedVehicles: [],
      pendingWeldLabel: null,
      clearWeldsSignal: s.clearWeldsSignal + 1,
    })),

  setRequestPointerLockFn: (fn) => set({ requestPointerLockFn: fn }),
  setRegisterExternalWeldFn: (fn) => set({ registerExternalWeldFn: fn }),
}));
