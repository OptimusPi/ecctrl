import { create } from "zustand";
import type { EcctrlVehicleHandle } from "../../src/vehicle";

export type ContorlType =
  | "ecctrl"
  | "vehicle1"
  | "vehicle2"
  | "vehicle3"
  | `simveh:${string}`;

export type VehicleAccessTargetType = {
  controller: Exclude<ContorlType, "ecctrl">;
  label: string;
} | null;

export interface DynamicVehicleEntry {
  id: `simveh:${string}`;
  label: string;
  mode: "car" | "drone";
  getHandle: () => EcctrlVehicleHandle | null;
}

export interface controlStoreState {
  activeController: ContorlType;
  vehicleAccessTarget: VehicleAccessTargetType;
  dynamicVehicles: Record<string, DynamicVehicleEntry>;
  nearbyDynamicVehicleId: `simveh:${string}` | null;
  setActiveController: (controller: ContorlType) => void;
  setVehicleAccessTarget: (target: VehicleAccessTargetType) => void;
  registerDynamicVehicle: (entry: DynamicVehicleEntry) => void;
  unregisterDynamicVehicle: (id: `simveh:${string}`) => void;
  setNearbyDynamicVehicle: (id: `simveh:${string}` | null) => void;
}

export const useControlStore = /* @__PURE__ */ create<controlStoreState>(
  (set) => ({
    activeController: "ecctrl",
    vehicleAccessTarget: null,
    dynamicVehicles: {},
    nearbyDynamicVehicleId: null,
    setActiveController: (status) => set({ activeController: status }),
    setVehicleAccessTarget: (target) => set({ vehicleAccessTarget: target }),
    registerDynamicVehicle: (entry) =>
      set((s) => ({
        dynamicVehicles: { ...s.dynamicVehicles, [entry.id]: entry },
      })),
    unregisterDynamicVehicle: (id) =>
      set((s) => {
        const next = { ...s.dynamicVehicles };
        delete next[id];
        return {
          dynamicVehicles: next,
          nearbyDynamicVehicleId:
            s.nearbyDynamicVehicleId === id ? null : s.nearbyDynamicVehicleId,
          activeController: s.activeController === id ? "ecctrl" : s.activeController,
          vehicleAccessTarget:
            s.vehicleAccessTarget?.controller === id ? null : s.vehicleAccessTarget,
        };
      }),
    setNearbyDynamicVehicle: (id) => set({ nearbyDynamicVehicleId: id }),
  })
);
