import React, { useCallback, useEffect, useRef, useState } from "react";
import { SimReadyUSDLoader } from "../../src/simready";
import { useToolGunStore, type ToolGunMode } from "./useToolGunStore";

const MODE_META: {
  id: ToolGunMode;
  keyNum: string;
  label: string;
  accent: string;
}[] = [
  { id: "physgun", keyNum: "1", label: "Physgun", accent: "#38bdf8" },
  { id: "spawner", keyNum: "2", label: "Spawn USD", accent: "#4ade80" },
  { id: "weld", keyNum: "3", label: "Weld / Axle", accent: "#facc15" },
  { id: "rig", keyNum: "4", label: "Make Vehicle", accent: "#c084fc" },
  { id: "remove", keyNum: "5", label: "Unweld / Del", accent: "#fb7185" },
];

export function ToolGunHUD() {
  const mode = useToolGunStore((s) => s.mode);
  const spawnerPreset = useToolGunStore((s) => s.spawnerPreset);
  const weldVariant = useToolGunStore((s) => s.weldVariant);
  const rigVariant = useToolGunStore((s) => s.rigVariant);
  const pointerLocked = useToolGunStore((s) => s.pointerLocked);
  const grabbing = useToolGunStore((s) => s.grabbing);
  const pendingWeldLabel = useToolGunStore((s) => s.pendingWeldLabel);
  const target = useToolGunStore((s) => s.target);
  const toast = useToolGunStore((s) => s.toast);
  const customAsset = useToolGunStore((s) => s.customAsset);
  const setMode = useToolGunStore((s) => s.setMode);
  const cycleSubVariant = useToolGunStore((s) => s.cycleSubVariant);
  const setCustomAsset = useToolGunStore((s) => s.setCustomAsset);
  const showToast = useToolGunStore((s) => s.showToast);
  const requestPointerLockFn = useToolGunStore((s) => s.requestPointerLockFn);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draggingFile, setDraggingFile] = useState(false);

  const loadUsdFile = useCallback(
    async (file: File) => {
      try {
        const buffer = await file.arrayBuffer();
        const loader = new SimReadyUSDLoader();
        const asset = loader.parse(buffer);
        setCustomAsset({ filename: file.name, asset });
        const rbCount = asset.physics.rigidBodies.length;
        const collCount = asset.physics.staticColliders.length;
        showToast(
          `Loaded ${file.name} (${rbCount} bodies, ${collCount} static colliders) into Tool Gun!`
        );
      } catch (err) {
        console.error(err);
        showToast(`Failed to parse ${file.name} as OpenUSD`);
      }
    },
    [setCustomAsset, showToast]
  );

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDraggingFile(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDraggingFile(false);
    };
    const onDrop = (e: DragEvent) => {
      setDraggingFile(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "usd" || ext === "usda" || ext === "usdc" || ext === "usdz") {
        e.preventDefault();
        void loadUsdFile(file);
      }
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [loadUsdFile]);

  const activeMeta = MODE_META.find((m) => m.id === mode) ?? MODE_META[0];

  let subVariantLabel = "";
  let fireHint = "";
  if (mode === "physgun") {
    subVariantLabel = "Freeze / Unfreeze [Q]";
    fireHint = pointerLocked
      ? "Hold LMB or [E]: Grab Beam • RMB/[Q]: Freeze in Air • [R]: Spin • Wheel: Distance"
      : "Hold [E] over prop: Grab Beam • [Q]: Freeze in Air • [R]: Spin • [Tab]: Crosshair Aim";
  } else if (mode === "spawner") {
    const presetNames: Record<string, string> = {
      pallet: "EuroPallet (.usdz)",
      sensor_pod: "SensorPod (.usdc)",
      crate: "Storage Crate",
      drum: "Hazard Drum",
      custom: customAsset ? customAsset.filename : "Custom USD",
    };
    subVariantLabel = `${presetNames[spawnerPreset] ?? "EuroPallet"} [Q]`;
    fireHint =
      "Click or [E]: Spawn SimReady USD Prop • [Q]: Cycle Asset • Drop any .usd/.usdc/.usdz file!";
  } else if (mode === "weld") {
    const weldNames: Record<string, string> = {
      fixed: "Rigid Weld [Q]",
      motor_hinge: "Motorized Spinning Axle [Q]",
      free_hinge: "Free Hinge [Q]",
    };
    subVariantLabel = weldNames[weldVariant];
    fireHint = pendingWeldLabel
      ? `Anchor 1: ${pendingWeldLabel} — Click or [E] on 2nd object/surface to complete joint`
      : "Click or [E] Object 1, then Object 2 to Weld/Hinge • [Q]: Cycle Weld / Motor Axle / Hinge";
  } else if (mode === "rig") {
    subVariantLabel =
      rigVariant === "car"
        ? "4x4 ShapeCast Car [Q]"
        : "Quad ThrustPropeller Drone [Q]";
    fireHint =
      "Click or [E] any SimReady prop (or ground) to rig into a drivable Vehicle! Walk up & press [F]";
  } else {
    subVariantLabel = "Clear All Spawns [Q]";
    fireHint =
      "Click or [E] to snap welds or dissolve Tool Gun props/vehicles • [Q]: Clear All";
  }

  return (
    <>
      {/* Top-Center Tool Gun Hotbar */}
      <div
        style={{
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 40,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 7px",
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.84)",
            border: "1px solid rgba(148, 163, 184, 0.24)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            pointerEvents: "auto",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {MODE_META.map((m) => {
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 10px",
                  borderRadius: 8,
                  border: active
                    ? `1px solid ${m.accent}`
                    : "1px solid transparent",
                  background: active
                    ? "rgba(30, 41, 59, 0.95)"
                    : "transparent",
                  color: active ? "#f8fafc" : "#94a3b8",
                  fontSize: 12,
                  fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  transition: "all 0.12s ease",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: active
                      ? m.accent
                      : "rgba(148, 163, 184, 0.16)",
                    color: active ? "#0f172a" : "#cbd5e1",
                  }}
                >
                  {m.keyNum}
                </span>
                <span>{m.label}</span>
              </button>
            );
          })}

          <div
            style={{
              width: 1,
              height: 18,
              background: "rgba(148, 163, 184, 0.25)",
              margin: "0 2px",
            }}
          />

          <button
            type="button"
            onClick={cycleSubVariant}
            title="Cycle Tool Variant (Key Q)"
            style={{
              padding: "5px 10px",
              borderRadius: 8,
              border: `1px solid ${activeMeta.accent}66`,
              background: "rgba(30, 41, 59, 0.8)",
              color: activeMeta.accent,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {subVariantLabel}
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Load any .usd / .usda / .usdc / .usdz into Tool Gun"
            style={{
              padding: "5px 9px",
              borderRadius: 8,
              border: "1px solid rgba(56, 189, 248, 0.35)",
              background: "rgba(14, 116, 144, 0.25)",
              color: "#7dd3fc",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + .USD*
          </button>

          <button
            type="button"
            onClick={() => requestPointerLockFn?.()}
            title="Toggle FPS Crosshair Aim Lock (Tab)"
            style={{
              padding: "5px 9px",
              borderRadius: 8,
              border: pointerLocked
                ? "1px solid #38bdf8"
                : "1px solid rgba(148, 163, 184, 0.25)",
              background: pointerLocked
                ? "rgba(56, 189, 248, 0.22)"
                : "rgba(30, 41, 59, 0.65)",
              color: pointerLocked ? "#38bdf8" : "#cbd5e1",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {pointerLocked ? "Aim Locked [Tab/Esc]" : "FPS Aim [Tab]"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".usd,.usda,.usdc,.usdz"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadUsdFile(f);
              e.target.value = "";
            }}
          />
        </div>

        {/* Compact Controls Sub-Bar */}
        <div
          style={{
            padding: "3px 11px",
            borderRadius: 999,
            background: "rgba(15, 23, 42, 0.72)",
            color: "#cbd5e1",
            fontSize: 11,
            letterSpacing: "0.01em",
            backdropFilter: "blur(6px)",
          }}
        >
          {fireHint}
        </div>

        {/* Live Action Toast */}
        {toast && (
          <div
            style={{
              padding: "5px 13px",
              borderRadius: 8,
              background: "rgba(15, 23, 42, 0.92)",
              border: `1px solid ${activeMeta.accent}`,
              color: "#f8fafc",
              fontSize: 12,
              fontWeight: 600,
              boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
            }}
          >
            {toast}
          </div>
        )}
      </div>

      {/* Center Crosshair & SimReady USD Scanner Readout */}
      {(pointerLocked || grabbing || target) && (
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 35,
            pointerEvents: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {pointerLocked && (
            <div
              style={{
                width: grabbing ? 14 : target ? 11 : 7,
                height: grabbing ? 14 : target ? 11 : 7,
                borderRadius: "50%",
                border: `2px solid ${
                  target || grabbing ? activeMeta.accent : "rgba(255,255,255,0.75)"
                }`,
                background: grabbing
                  ? activeMeta.accent
                  : "rgba(15, 23, 42, 0.35)",
                boxShadow: "0 0 8px rgba(0,0,0,0.5)",
                transition: "all 0.08s ease",
              }}
            />
          )}

          {target && (
            <div
              style={{
                marginTop: pointerLocked ? 14 : 26,
                padding: "3px 9px",
                borderRadius: 6,
                background: "rgba(15, 23, 42, 0.84)",
                border: `1px solid ${activeMeta.accent}88`,
                color: "#f1f5f9",
                fontSize: 11,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: activeMeta.accent, fontWeight: 700 }}>
                {target.name}
              </span>
              {target.qCode && (
                <span style={{ color: "#94a3b8" }}> • {target.qCode}</span>
              )}
              {target.mass !== undefined && (
                <span style={{ color: "#cbd5e1" }}> • {target.mass}kg</span>
              )}
              {target.frozen && (
                <span style={{ color: "#22d3ee", fontWeight: 700 }}>
                  {" "}
                  [FROZEN]
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drag-and-drop OpenUSD Overlay */}
      {draggingFile && (
        <div
          style={{
            position: "fixed",
            inset: 16,
            zIndex: 60,
            borderRadius: 18,
            border: "2px dashed #38bdf8",
            background: "rgba(15, 23, 42, 0.72)",
            backdropFilter: "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#e0f2fe",
            fontSize: 20,
            fontWeight: 700,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            pointerEvents: "none",
          }}
        >
          Drop .usd / .usda / .usdc / .usdz to load into SimReady Tool Gun
        </div>
      )}
    </>
  );
}
