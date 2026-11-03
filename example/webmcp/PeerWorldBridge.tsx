import * as THREE from "three";
import React, { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import {
  BallCollider,
  RigidBody,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import type { UnitImpulseJoint } from "@dimforge/rapier3d-compat";
import type { EcctrlHandle } from "../../src";
import type { EcctrlVehicleHandle } from "../../src/vehicle";
import { useCustomGravity } from "../../src/gravity";
import {
  computeSimReadyBounds,
  SimReadyUSDLoader,
  useSimReadyUSD,
  type SimReadyRigidBodyDesc,
} from "../../src/simready";
import {
  postPeerChatMessage,
  useWebMCPBridge,
  useWebMCPTools,
  type WebMCPToolDefinition,
} from "../../src/webmcp";
import { useControlStore } from "../store/useControlStore";
import { useToolGunStore } from "../toolgun/useToolGunStore";
import { usePeerStore, type AutopilotAction } from "./usePeerStore";

interface SimReadyUserDataMeta {
  primPath?: string;
  name?: string;
  semantics?: {
    labels: Record<string, string>;
    wikidataQCode?: string;
  };
  desc?: SimReadyRigidBodyDesc;
  retireBody?: () => void;
  isSpawnedProp?: boolean;
  spawnId?: string;
  isRiggedVehicle?: boolean;
  riggedId?: `simveh:${string}`;
  staticEnvironment?: boolean;
  physgunFrozen?: boolean;
}

let peerSpawnCounter = 5000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PeerWorldBridgeProps {
  ecctrlRef: RefObject<EcctrlHandle | null>;
  vehicle1Ref: RefObject<EcctrlVehicleHandle | null>;
  vehicle2Ref: RefObject<EcctrlVehicleHandle | null>;
  vehicle3Ref: RefObject<EcctrlVehicleHandle | null>;
  timeScaleRef?: RefObject<number>;
  defaultGravityField?: (pos: THREE.Vector3) => THREE.Vector3;
  paused?: boolean;
}

export function PeerWorldBridge({
  ecctrlRef,
  vehicle1Ref,
  vehicle2Ref,
  vehicle3Ref,
  timeScaleRef,
  defaultGravityField,
  paused = false,
}: PeerWorldBridgeProps) {
  const { rapier, world } = useRapier();
  const { camera } = useThree();
  const setGravityField = useCustomGravity((s) => s.setGravityField);
  const getGravityAtPos = useCustomGravity((s) => s.getGravityAtPos);

  const bayAsset = useSimReadyUSD("/simready/warehouse_bay.usdz");
  const podAsset = useSimReadyUSD("/simready/sensor_pod.usdc");

  const peerBodyRef = useRef<RapierRigidBody>(null);
  const outerRingRef = useRef<THREE.Mesh>(null);
  const peerCurrentPosRef = useRef(new THREE.Vector3(2.6, 3.6, -58.5));
  const peerCurrentQuatRef = useRef(new THREE.Quaternion());
  const worldAnchorRef = useRef<RapierRigidBody>(null);

  const peerBot = usePeerStore((s) => s.peerBot);

  const beamGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(6), 3)
    );
    return g;
  }, []);

  const beamMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: "#34d399",
        transparent: true,
        opacity: 0.95,
      }),
    []
  );

  const beamLineObj = useMemo(
    () => new THREE.Line(beamGeom, beamMat),
    [beamGeom, beamMat]
  );
  const beamLineRef = useRef<THREE.Line>(null);
  const beamOrbRef = useRef<THREE.Mesh>(null);

  const getActiveActorBodyAndPos = useCallback((): {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    forward: THREE.Vector3;
    body: RapierRigidBody | null;
  } => {
    const ctrl = useControlStore.getState();
    const active = ctrl.activeController;

    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    camFwd.y = 0;
    if (camFwd.lengthSq() < 0.001) camFwd.set(0, 0, -1);
    else camFwd.normalize();

    let body: RapierRigidBody | null = null;
    if (active === "ecctrl") body = ecctrlRef.current?.body ?? null;
    else if (active === "vehicle1") body = vehicle1Ref.current?.body ?? null;
    else if (active === "vehicle2") body = vehicle2Ref.current?.body ?? null;
    else if (active === "vehicle3") body = vehicle3Ref.current?.body ?? null;
    else if (active.startsWith("simveh:")) {
      body = ctrl.dynamicVehicles[active]?.getHandle()?.body ?? null;
    }

    if (body) {
      const t = body.translation();
      const lv = body.linvel();
      return {
        pos: new THREE.Vector3(t.x, t.y, t.z),
        vel: new THREE.Vector3(lv.x, lv.y, lv.z),
        forward: camFwd,
        body,
      };
    }

    return {
      pos: new THREE.Vector3(0, 3, -60),
      vel: new THREE.Vector3(),
      forward: camFwd,
      body: null,
    };
  }, [camera, ecctrlRef, vehicle1Ref, vehicle2Ref, vehicle3Ref]);

  // Register live player context getter so human chat messages automatically include spatial context
  useEffect(() => {
    usePeerStore.getState().setGetPlayerContextCallback(() => {
      const { pos } = getActiveActorBodyAndPos();
      const ctrl = useControlStore.getState().activeController;
      const target = useToolGunStore.getState().target;
      return {
        playerPos: [round2(pos.x), round2(pos.y), round2(pos.z)],
        activeController: ctrl,
        aimTarget: target
          ? `${target.name} (handle=${target.key}${target.qCode ? `, ${target.qCode}` : ""})`
          : null,
      };
    });
    return () => usePeerStore.getState().setGetPlayerContextCallback(null);
  }, [getActiveActorBodyAndPos]);

  // Connect SSE + HTTP bridge to Vite `/api/webmcp` + `/mcp`
  useWebMCPBridge({
    endpointPrefix: "/api/webmcp",
    onStatusChange: (connected) => {
      usePeerStore.getState().setBridgeConnected(connected);
    },
    onChatMessage: (_latest, all) => {
      if (all) usePeerStore.getState().upsertMessages(all);
      else usePeerStore.getState().upsertMessages(_latest);
    },
    onToolCall: (record) => {
      usePeerStore.getState().pushToolRecord(record);
    },
  });

  const pickPresetDesc = useCallback(
    (presetName?: string): { label: string; desc: SimReadyRigidBodyDesc } | null => {
      const key = (presetName ?? "pallet").toLowerCase();
      if (key === "sensor_pod" || key === "pod" || key === "usdc") {
        const rb = podAsset.physics.rigidBodies[0];
        if (rb) return { label: "SensorPod (.usdc)", desc: rb };
      }
      const map: Record<string, { path: string; label: string }> = {
        pallet: { path: "/World/Pallet_01", label: "EuroPallet" },
        crate: { path: "/World/Crate_01", label: "StorageCrate" },
        drum: { path: "/World/HazardDrum_01", label: "HazardDrum" },
      };
      const entry = map[key] ?? map.pallet;
      const found = bayAsset.physics.rigidBodies.find(
        (b) => b.primPath === entry.path
      );
      return found ? { label: entry.label, desc: found } : null;
    },
    [bayAsset, podAsset]
  );

  const computePlacementPos = useCallback(
    (
      where?: string,
      explicitPos?: unknown
    ): [number, number, number] => {
      if (
        Array.isArray(explicitPos) &&
        explicitPos.length >= 3 &&
        typeof explicitPos[0] === "number"
      ) {
        return [
          Number(explicitPos[0]),
          Number(explicitPos[1]),
          Number(explicitPos[2]),
        ];
      }

      const actor = getActiveActorBodyAndPos();
      const mode = where ?? "in_front_of_player";

      if (mode === "above_player") {
        return [actor.pos.x, actor.pos.y + 4.5, actor.pos.z];
      }
      if (mode === "near_peer_bot") {
        const p = peerCurrentPosRef.current;
        return [p.x, Math.max(1.2, p.y - 0.6), p.z];
      }
      if (mode === "player_aim") {
        const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(
          camera.quaternion
        );
        const ray = new rapier.Ray(
          { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          { x: aimDir.x, y: aimDir.y, z: aimDir.z }
        );
        const hit = world.castRay(ray, 60, true);
        if (hit) {
          const pt = new THREE.Vector3()
            .copy(camera.position)
            .addScaledVector(aimDir, hit.timeOfImpact);
          return [pt.x, pt.y + 0.65, pt.z];
        }
      }

      const fwdPt = actor.pos.clone().addScaledVector(actor.forward, 4.2);
      return [fwdPt.x, actor.pos.y + 0.9, fwdPt.z];
    },
    [camera, getActiveActorBodyAndPos, rapier, world]
  );

  // Define the 12 peer-to-peer WebMCP tools
  const tools = useMemo<WebMCPToolDefinition<any, any>[]>(
    () => [
      {
        name: "get_world_state",
        description:
          "Inspect the live 3D Ecctrl + Rapier + SimReady OpenUSD scene: human player position/controller/crosshair target, AI Peer Bot position, all dynamic SimReady rigid bodies (handles, USD primPaths, Wikidata Q-codes, masses, positions), rigged vehicles, and recent peer chat.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            maxBodies: {
              type: "number",
              description: "Maximum rigid bodies to list (default 40).",
            },
          },
        },
        execute: async ({ maxBodies = 40 }: { maxBodies?: number }) => {
          const actor = getActiveActorBodyAndPos();
          const ctrlStore = useControlStore.getState();
          const tgStore = useToolGunStore.getState();
          const peerState = usePeerStore.getState();

          const bodies: Array<Record<string, unknown>> = [];
          world.bodies.forEach((rb) => {
            if (bodies.length >= maxBodies) return;
            const sim = (rb.userData as { simReady?: SimReadyUserDataMeta } | undefined)
              ?.simReady;
            if (!rb.isDynamic() && !sim) return;
            if (sim?.staticEnvironment) return;
            if (rb === ecctrlRef.current?.body || rb === peerBodyRef.current) return;

            const t = rb.translation();
            bodies.push({
              handle: rb.handle,
              name: sim?.name ?? (rb.isDynamic() ? "DynamicBody" : "KinematicBody"),
              primPath: sim?.primPath,
              qCode: sim?.semantics?.wikidataQCode,
              position: [round2(t.x), round2(t.y), round2(t.z)],
              massKg: rb.isDynamic() ? round2(rb.mass()) : 0,
              frozen: Boolean(sim?.physgunFrozen),
              isRiggedVehicle: Boolean(sim?.isRiggedVehicle),
              riggedId: sim?.riggedId,
            });
          });

          const gSample = getGravityAtPos(actor.pos).clone();

          return {
            player: {
              activeController: ctrlStore.activeController,
              position: [round2(actor.pos.x), round2(actor.pos.y), round2(actor.pos.z)],
              velocity: [round2(actor.vel.x), round2(actor.vel.y), round2(actor.vel.z)],
              aimingAt: tgStore.target,
              toolGunMode: tgStore.mode,
            },
            peerBot: {
              position: [
                round2(peerCurrentPosRef.current.x),
                round2(peerCurrentPosRef.current.y),
                round2(peerCurrentPosRef.current.z),
              ],
              followingPlayer: peerState.peerBot.followPlayer,
            },
            gravityAtPlayer: [round2(gSample.x), round2(gSample.y), round2(gSample.z)],
            timeScale: timeScaleRef?.current ?? 1,
            paused,
            riggedVehicles: tgStore.riggedVehicles.map((v) => ({
              id: v.id,
              label: v.label,
              mode: v.mode,
              drivenByPlayer: ctrlStore.activeController === v.id,
              autopilot: peerState.autopilots[v.id]?.action ?? null,
            })),
            bodies,
            recentChat: peerState.messages.slice(-10),
          };
        },
      },

      {
        name: "peer_chat",
        description:
          "Send a live peer chat message to the human player inside the 3D viewport (displays in Peer Comms chat + 3D speech bubble over your AI Peer Bot, with optional 3D laser ping).",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Chat message to show to your human peer.",
            },
            senderName: {
              type: "string",
              description: "Display name (default: 'AI Peer').",
            },
            moveNearPlayer: {
              type: "boolean",
              description: "Hover your 3D Peer Bot near the player (default true).",
            },
            pingPosition: {
              type: "array",
              items: { type: "number" },
              description: "Optional [x, y, z] coordinate to point your 3D laser beam at.",
            },
          },
          required: ["message"],
        },
        execute: async (input: {
          message: string;
          senderName?: string;
          moveNearPlayer?: boolean;
          pingPosition?: [number, number, number];
          _alreadyLoggedId?: string;
        }) => {
          const name = input.senderName?.trim() || "AI Peer";
          const text = String(input.message ?? "").trim();

          if (!input._alreadyLoggedId && text) {
            const msg = await postPeerChatMessage({
              sender: "agent",
              name,
              text,
            });
            usePeerStore.getState().upsertMessages(msg);
          }

          const actor = getActiveActorBodyAndPos();
          const hasPing =
            Array.isArray(input.pingPosition) && input.pingPosition.length >= 3;
          const pingTuple: [number, number, number] | null = hasPing
            ? [
                Number(input.pingPosition![0]),
                Number(input.pingPosition![1]),
                Number(input.pingPosition![2]),
              ]
            : null;

          usePeerStore.getState().commandPeerBot({
            ...(input.moveNearPlayer !== false
              ? {
                  followPlayer: !pingTuple,
                  targetPosition: pingTuple
                    ? [pingTuple[0] + 1.5, pingTuple[1] + 2.0, pingTuple[2] + 1.5]
                    : [actor.pos.x + 2.4, actor.pos.y + 1.8, actor.pos.z + 1.8],
                }
              : {}),
            beamTarget: pingTuple,
            beamColor: "#38bdf8",
            beamDurationMs: 2500,
            speechText: text,
            speechSender: name,
            speechDurationMs: 9000,
          });

          return {
            ok: true,
            said: text,
            playerPosition: [
              round2(actor.pos.x),
              round2(actor.pos.y),
              round2(actor.pos.z),
            ],
          };
        },
      },

      {
        name: "read_peer_chat",
        description:
          "Read recent chat messages from the human player along with their live 3D coordinates and current crosshair target.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max messages to return (default 30)." },
          },
        },
        execute: async ({ limit = 30 }: { limit?: number }) => {
          const actor = getActiveActorBodyAndPos();
          const tg = useToolGunStore.getState();
          return {
            playerPosition: [
              round2(actor.pos.x),
              round2(actor.pos.y),
              round2(actor.pos.z),
            ],
            activeController: useControlStore.getState().activeController,
            aimingAt: tg.target,
            messages: usePeerStore.getState().messages.slice(-limit),
          };
        },
      },

      {
        name: "peer_bot_move",
        description:
          "Fly your physical 3D AI Peer Bot in the scene to a landmark or [x, y, z] coordinate, toggle player-follow mode, or point a 3D laser beam at an object/coordinate.",
        inputSchema: {
          type: "object",
          properties: {
            destination: {
              type: "string",
              enum: ["near_player", "player_aim", "simready_bay", "origin", "coordinates"],
              description: "Where to fly the 3D Peer Bot.",
            },
            position: {
              type: "array",
              items: { type: "number" },
              description: "Explicit [x, y, z] when destination='coordinates'.",
            },
            followPlayer: {
              type: "boolean",
              description: "Continuously accompany the human player.",
            },
            pingTarget: {
              type: "array",
              items: { type: "number" },
              description: "Optional [x, y, z] point to highlight with a 3D beam.",
            },
          },
        },
        execute: async (input: {
          destination?: string;
          position?: [number, number, number];
          followPlayer?: boolean;
          pingTarget?: [number, number, number];
        }) => {
          const actor = getActiveActorBodyAndPos();
          let targetPos: [number, number, number] = [
            actor.pos.x + 2.4,
            actor.pos.y + 1.8,
            actor.pos.z + 1.8,
          ];
          let follow = input.followPlayer ?? false;

          if (input.destination === "near_player") {
            follow = input.followPlayer ?? true;
          } else if (input.destination === "simready_bay") {
            targetPos = [0, 3.8, -81.5];
          } else if (input.destination === "origin") {
            targetPos = [0, 4, 0];
          } else if (input.destination === "player_aim") {
            const pt = computePlacementPos("player_aim");
            targetPos = [pt[0], pt[1] + 1.8, pt[2]];
          } else if (Array.isArray(input.position) && input.position.length >= 3) {
            targetPos = [
              Number(input.position[0]),
              Number(input.position[1]),
              Number(input.position[2]),
            ];
          }

          const beam: [number, number, number] | null =
            Array.isArray(input.pingTarget) && input.pingTarget.length >= 3
              ? [
                  Number(input.pingTarget[0]),
                  Number(input.pingTarget[1]),
                  Number(input.pingTarget[2]),
                ]
              : null;

          usePeerStore.getState().commandPeerBot({
            targetPosition: targetPos,
            followPlayer: follow,
            beamTarget: beam,
            beamColor: "#22d3ee",
            beamDurationMs: 2200,
          });

          return { ok: true, targetPosition: targetPos, followPlayer: follow };
        },
      },

      {
        name: "spawn_simready_prop",
        description:
          "Spawn 1–12 NVIDIA SimReady OpenUSD props ('pallet', 'sensor_pod', 'crate', 'drum', or any .usd/.usda/.usdc/.usdz URL) into the live Rapier physics world.",
        inputSchema: {
          type: "object",
          properties: {
            asset: {
              type: "string",
              enum: ["pallet", "sensor_pod", "crate", "drum"],
              description: "Built-in SimReady USDZ/USDC preset.",
            },
            url: {
              type: "string",
              description: "Optional custom URL to a .usd, .usda, .usdc, or .usdz asset.",
            },
            where: {
              type: "string",
              enum: [
                "in_front_of_player",
                "player_aim",
                "above_player",
                "near_peer_bot",
                "coordinates",
              ],
              description: "Placement mode (default: 'in_front_of_player').",
            },
            position: {
              type: "array",
              items: { type: "number" },
              description: "Explicit [x, y, z] coordinates.",
            },
            count: {
              type: "number",
              description: "How many props to spawn (1 to 12, default 1).",
            },
          },
        },
        execute: async (input: {
          asset?: string;
          url?: string;
          where?: string;
          position?: [number, number, number];
          count?: number;
        }) => {
          let label = "EuroPallet";
          let desc: SimReadyRigidBodyDesc | null = null;

          if (input.url) {
            const loader = new SimReadyUSDLoader();
            const parsed = await loader.loadAsync(input.url);
            desc =
              parsed.physics.rigidBodies[0] ?? {
                id: `/RemoteUSD/${Date.now()}`,
                name: input.url.split("/").pop() || "USDProp",
                primPath: "/",
                bodyType: "dynamic",
                position: [0, 0, 0],
                quaternion: [0, 0, 0, 1],
                mass: 20,
                colliders: parsed.physics.staticColliders,
                visualGroup: parsed.physics.staticVisualGroup,
                apiSchemas: ["PhysicsRigidBodyAPI"],
              };
            label = desc.name;
          } else {
            const chosen = pickPresetDesc(input.asset);
            if (!chosen) throw new Error("Failed to resolve SimReady preset");
            label = chosen.label;
            desc = chosen.desc;
          }

          const basePos = computePlacementPos(input.where, input.position);
          const count = Math.max(1, Math.min(12, Math.floor(input.count ?? 1)));
          const spawnedIds: string[] = [];

          for (let i = 0; i < count; i++) {
            const id = `peerprop_${peerSpawnCounter++}`;
            const pos: [number, number, number] = [
              basePos[0] + ((i % 2) - 0.5) * (count > 1 ? 0.35 : 0),
              basePos[1] + i * 0.65,
              basePos[2] + (Math.floor(i / 2) % 2) * (count > 1 ? 0.35 : 0),
            ];
            useToolGunStore.getState().addSpawnedProp({
              id,
              label,
              desc,
              position: pos,
              quaternion: desc.quaternion,
            });
            spawnedIds.push(id);
          }

          usePeerStore.getState().commandPeerBot({
            followPlayer: false,
            targetPosition: [basePos[0] + 1.8, basePos[1] + 2.0, basePos[2] + 1.8],
            beamTarget: basePos,
            beamColor: "#4ade80",
            beamDurationMs: 1800,
          });
          useToolGunStore
            .getState()
            .showToast(`AI Peer spawned ${count}× ${label}`);

          return {
            ok: true,
            spawnedIds,
            label,
            count,
            position: [round2(basePos[0]), round2(basePos[1]), round2(basePos[2])],
          };
        },
      },

      {
        name: "rig_simready_vehicle",
        description:
          "Auto-rig an existing SimReady USD body (by bodyHandle or name/Q-code) OR spawn + rig a new drivable EcctrlVehicle ('car' with 4x4 ShapeCastWheels or 'drone' with 4x ThrustPropellers).",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["car", "drone"],
              description: "Vehicle controller rig mode (default: 'car').",
            },
            targetBodyHandle: {
              type: "number",
              description: "Optional live Rapier RigidBody handle to upgrade in-place.",
            },
            assetPreset: {
              type: "string",
              enum: ["pallet", "sensor_pod", "crate", "drum"],
              description: "SimReady USD preset when spawning a new vehicle.",
            },
            where: {
              type: "string",
              enum: ["in_front_of_player", "player_aim", "coordinates"],
              description: "Where to spawn the rigged vehicle.",
            },
            position: {
              type: "array",
              items: { type: "number" },
              description: "Explicit [x, y, z] coordinates.",
            },
            autoEnterForPlayer: {
              type: "boolean",
              description: "Immediately seat the human player inside the new vehicle.",
            },
          },
        },
        execute: async (input: {
          mode?: "car" | "drone";
          targetBodyHandle?: number;
          assetPreset?: string;
          where?: string;
          position?: [number, number, number];
          autoEnterForPlayer?: boolean;
        }) => {
          const rigMode = input.mode === "drone" ? "drone" : "car";
          let targetDesc: SimReadyRigidBodyDesc | undefined;
          let baseName = "SimReady";
          let spawnPos: [number, number, number];

          if (typeof input.targetBodyHandle === "number") {
            const rb = world.getRigidBody(input.targetBodyHandle);
            const sim = (rb?.userData as { simReady?: SimReadyUserDataMeta } | undefined)
              ?.simReady;
            if (rb && sim?.desc && !sim.isRiggedVehicle) {
              targetDesc = sim.desc;
              baseName = sim.name ?? sim.desc.name;
              const t = rb.translation();
              const { bounds } = computeSimReadyBounds(targetDesc, 1);
              const lift =
                rigMode === "car"
                  ? bounds.halfExtents[1] + 0.45
                  : bounds.halfExtents[1] + 0.95;
              spawnPos = [t.x, t.y + lift, t.z];
              sim.retireBody?.();
            } else {
              throw new Error(
                `Body handle ${input.targetBodyHandle} is not an upgradable SimReady prop.`
              );
            }
          } else {
            const fallback = pickPresetDesc(
              input.assetPreset ?? (rigMode === "drone" ? "sensor_pod" : "pallet")
            );
            if (!fallback) throw new Error("Failed to resolve SimReady preset");
            targetDesc = fallback.desc;
            baseName = fallback.label;
            const pt = computePlacementPos(input.where, input.position);
            const { bounds } = computeSimReadyBounds(targetDesc, 1);
            const lift =
              rigMode === "car"
                ? bounds.halfExtents[1] + 0.45
                : bounds.halfExtents[1] + 1.05;
            spawnPos = [pt[0], pt[1] + lift, pt[2]];
          }

          const actor = getActiveActorBodyAndPos();
          const yaw = Math.atan2(actor.forward.x, actor.forward.z);
          const vehId = `simveh:${peerSpawnCounter++}` as const;
          const label = `${baseName} ${rigMode === "car" ? "Buggy" : "Drone"}`;

          useToolGunStore.getState().addRiggedVehicle({
            id: vehId,
            label,
            mode: rigMode,
            desc: targetDesc,
            position: spawnPos,
            rotation: [0, yaw, 0],
          });

          if (input.autoEnterForPlayer) {
            setTimeout(() => {
              useControlStore.getState().setActiveController(vehId);
            }, 80);
          }

          usePeerStore.getState().commandPeerBot({
            followPlayer: false,
            targetPosition: [spawnPos[0] + 2.0, spawnPos[1] + 1.9, spawnPos[2] + 2.0],
            beamTarget: spawnPos,
            beamColor: "#c084fc",
            beamDurationMs: 2000,
          });
          useToolGunStore
            .getState()
            .showToast(`AI Peer rigged ${label}! Press [F] to drive`);

          return {
            ok: true,
            vehicleId: vehId,
            label,
            mode: rigMode,
            position: [round2(spawnPos[0]), round2(spawnPos[1]), round2(spawnPos[2])],
          };
        },
      },

      {
        name: "pilot_vehicle",
        description:
          "Autonomously drive or fly any SimReady rigged vehicle (or built-in vehicle1/vehicle2/vehicle3) as an AI peer alongside the human player!",
        inputSchema: {
          type: "object",
          properties: {
            vehicleId: {
              type: "string",
              description:
                "Vehicle ID (e.g. 'simveh:5000', 'latest', 'vehicle1', 'vehicle2', 'vehicle3'). Defaults to 'latest'.",
            },
            action: {
              type: "string",
              enum: [
                "forward",
                "reverse",
                "circle_left",
                "circle_right",
                "hover_up",
                "hover_spin",
                "brake",
                "stop",
              ],
              description: "Driving/flying maneuver to perform.",
            },
            durationSeconds: {
              type: "number",
              description: "How many seconds to maintain the maneuver (default 4).",
            },
          },
          required: ["action"],
        },
        execute: async (input: {
          vehicleId?: string;
          action: AutopilotAction | "stop";
          durationSeconds?: number;
        }) => {
          const rigged = useToolGunStore.getState().riggedVehicles;
          let targetId = input.vehicleId ?? "latest";
          if (targetId === "latest") {
            const last = rigged[rigged.length - 1];
            targetId = last ? last.id : "vehicle1";
          }

          if (input.action === "stop") {
            usePeerStore.getState().clearAutopilot(targetId);
            return { ok: true, vehicleId: targetId, stopped: true };
          }

          const dur = Math.max(0.5, Math.min(30, Number(input.durationSeconds ?? 4)));
          usePeerStore.getState().setAutopilot(targetId, input.action, dur);
          useToolGunStore
            .getState()
            .showToast(`AI Peer piloting ${targetId} (${input.action} ${dur}s)`);

          return {
            ok: true,
            vehicleId: targetId,
            action: input.action,
            durationSeconds: dur,
          };
        },
      },

      {
        name: "weld_bodies",
        description:
          "Weld or hinge two Rapier rigid bodies together (or weld body0Handle to the static world when body1Handle is omitted) with visible 3D tether lines.",
        inputSchema: {
          type: "object",
          properties: {
            body0Handle: {
              type: "number",
              description: "Rapier handle of the first dynamic RigidBody.",
            },
            body1Handle: {
              type: "number",
              description:
                "Optional Rapier handle of the second RigidBody (omit to anchor to static world).",
            },
            jointType: {
              type: "string",
              enum: ["fixed", "motor_hinge", "free_hinge"],
              description: "Joint constraint type (default 'fixed').",
            },
            motorSpeed: {
              type: "number",
              description: "Target angular speed in rad/s when jointType='motor_hinge' (default 5).",
            },
          },
          required: ["body0Handle"],
        },
        execute: async (input: {
          body0Handle: number;
          body1Handle?: number;
          jointType?: "fixed" | "motor_hinge" | "free_hinge";
          motorSpeed?: number;
        }) => {
          const b0 = world.getRigidBody(input.body0Handle);
          const b1 =
            typeof input.body1Handle === "number"
              ? world.getRigidBody(input.body1Handle)
              : worldAnchorRef.current;

          if (!b0 || !b1) {
            throw new Error("Could not find specified rigid body handle(s).");
          }
          if (b0.handle === b1.handle) {
            throw new Error("Cannot weld a body to itself.");
          }

          const t0 = b0.translation();
          const r0 = b0.rotation();
          const q0 = new THREE.Quaternion(r0.x, r0.y, r0.z, r0.w);

          const t1 = b1.translation();
          const r1 = b1.rotation();
          const q1 = new THREE.Quaternion(r1.x, r1.y, r1.z, r1.w);
          const invQ1 = q1.clone().invert();

          const anchorWorld = new THREE.Vector3(t0.x, t0.y, t0.z);
          const localA0 = new THREE.Vector3(0, 0, 0);
          const localA1 = anchorWorld
            .clone()
            .sub(new THREE.Vector3(t1.x, t1.y, t1.z))
            .applyQuaternion(invQ1);

          const jType = input.jointType ?? "fixed";
          let joint;

          if (jType === "fixed") {
            const relQ = invQ1.clone().multiply(q0).normalize();
            const data = rapier.JointData.fixed(
              { x: 0, y: 0, z: 0 },
              { x: 0, y: 0, z: 0, w: 1 },
              { x: localA1.x, y: localA1.y, z: localA1.z },
              { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w }
            );
            joint = world.createImpulseJoint(data, b0, b1, true);
          } else {
            const upInB0 = new THREE.Vector3(0, 1, 0)
              .applyQuaternion(q0.clone().invert())
              .normalize();
            const upInB1 = new THREE.Vector3(0, 1, 0)
              .applyQuaternion(invQ1)
              .normalize();
            const data = rapier.JointData.revolute(
              { x: 0, y: 0, z: 0 },
              { x: localA1.x, y: localA1.y, z: localA1.z },
              { x: upInB0.x, y: upInB0.y, z: upInB0.z }
            );
            data.axis = { x: upInB1.x, y: upInB1.y, z: upInB1.z };
            joint = world.createImpulseJoint(data, b0, b1, true);
            joint.setContactsEnabled(false);

            if (jType === "motor_hinge") {
              const unit = joint as UnitImpulseJoint;
              unit.configureMotorModel(rapier.MotorModel.ForceBased);
              unit.configureMotorVelocity(Number(input.motorSpeed ?? 5), 50);
            }
          }

          useToolGunStore.getState().registerExternalWeldFn?.({
            joint,
            body0Handle: b0.handle,
            body1Handle: b1.handle,
            localAnchor0: [localA0.x, localA0.y, localA0.z],
            localAnchor1: [localA1.x, localA1.y, localA1.z],
            color: jType === "fixed" ? "#facc15" : "#fb923c",
          });

          usePeerStore.getState().commandPeerBot({
            beamTarget: [t0.x, t0.y, t0.z],
            beamColor: "#facc15",
            beamDurationMs: 1800,
          });

          return {
            ok: true,
            jointType: jType,
            body0Handle: b0.handle,
            body1Handle: b1.handle,
          };
        },
      },

      {
        name: "manipulate_body",
        description:
          "Apply impulse, teleport, freeze, unfreeze, or remove a rigid body by handle OR all SimReady bodies matching a name / Wikidata Q-code (e.g. 'Q5153359', 'Q1065449', 'Q11012').",
        inputSchema: {
          type: "object",
          properties: {
            bodyHandle: {
              type: "number",
              description: "Specific Rapier RigidBody handle.",
            },
            query: {
              type: "string",
              description:
                "Match SimReady bodies by name, primPath, or Wikidata Q-code (e.g. 'Q5153359').",
            },
            operation: {
              type: "string",
              enum: ["impulse", "teleport", "freeze", "unfreeze", "remove"],
              description: "Physics manipulation to perform.",
            },
            vector: {
              type: "array",
              items: { type: "number" },
              description: "Impulse [ix, iy, iz] or target position [x, y, z].",
            },
          },
          required: ["operation"],
        },
        execute: async (input: {
          bodyHandle?: number;
          query?: string;
          operation: "impulse" | "teleport" | "freeze" | "unfreeze" | "remove";
          vector?: [number, number, number];
        }) => {
          const matched: RapierRigidBody[] = [];

          if (typeof input.bodyHandle === "number") {
            const b = world.getRigidBody(input.bodyHandle);
            if (b) matched.push(b);
          } else if (input.query) {
            const needle = input.query.trim().toLowerCase();
            world.bodies.forEach((rb) => {
              const sim = (rb.userData as { simReady?: SimReadyUserDataMeta } | undefined)
                ?.simReady;
              if (!sim || sim.staticEnvironment) return;
              const hay = [
                sim.name,
                sim.primPath,
                sim.semantics?.wikidataQCode,
                ...(sim.semantics ? Object.values(sim.semantics.labels) : []),
              ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              if (hay.includes(needle)) matched.push(rb);
            });
          }

          if (matched.length === 0) {
            throw new Error("No matching rigid bodies found.");
          }

          const vec: [number, number, number] =
            Array.isArray(input.vector) && input.vector.length >= 3
              ? [Number(input.vector[0]), Number(input.vector[1]), Number(input.vector[2])]
              : [0, 80, 0];

          let firstPos: [number, number, number] | null = null;
          for (const rb of matched) {
            const t = rb.translation();
            if (!firstPos) firstPos = [t.x, t.y, t.z];
            const userData = ((rb.userData as Record<string, unknown>) ?? {});
            const sim: SimReadyUserDataMeta =
              (userData.simReady as SimReadyUserDataMeta) ?? {};

            if (input.operation === "impulse") {
              if (rb.isDynamic()) {
                rb.wakeUp();
                rb.applyImpulse({ x: vec[0], y: vec[1], z: vec[2] }, true);
              }
            } else if (input.operation === "teleport") {
              rb.setTranslation({ x: vec[0], y: vec[1], z: vec[2] }, true);
              rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
              rb.wakeUp();
            } else if (input.operation === "freeze") {
              rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
              rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
              rb.setBodyType(rapier.RigidBodyType.Fixed, true);
              sim.physgunFrozen = true;
              userData.simReady = sim;
              rb.userData = userData;
            } else if (input.operation === "unfreeze") {
              sim.physgunFrozen = false;
              userData.simReady = sim;
              rb.userData = userData;
              rb.setBodyType(rapier.RigidBodyType.Dynamic, true);
              rb.wakeUp();
            } else if (input.operation === "remove") {
              if (sim.isRiggedVehicle && sim.riggedId) {
                useToolGunStore.getState().removeRiggedVehicle(sim.riggedId);
              } else if (sim.retireBody) {
                sim.retireBody();
              }
            }
          }

          if (firstPos) {
            usePeerStore.getState().commandPeerBot({
              beamTarget: firstPos,
              beamColor: "#38bdf8",
              beamDurationMs: 1400,
            });
          }

          return {
            ok: true,
            operation: input.operation,
            affectedCount: matched.length,
          };
        },
      },

      {
        name: "set_world_physics",
        description:
          "Modify global custom gravity ('earth', 'moon', 'mars', 'zero_g', 'inverted', 'default_field', or custom [gx, gy, gz]), bullet-time timeScale, pause state, or Rapier wireframe debug.",
        inputSchema: {
          type: "object",
          properties: {
            gravityPreset: {
              type: "string",
              enum: [
                "earth",
                "moon",
                "mars",
                "zero_g",
                "inverted",
                "default_field",
              ],
              description: "Named gravity preset.",
            },
            gravityVector: {
              type: "array",
              items: { type: "number" },
              description: "Custom uniform gravity vector [gx, gy, gz] in m/s².",
            },
            timeScale: {
              type: "number",
              description: "Simulation speed multiplier (0.05 to 1.5).",
            },
            paused: {
              type: "boolean",
              description: "Pause or resume Rapier simulation.",
            },
            physicsDebug: {
              type: "boolean",
              description: "Show or hide Rapier collider wireframes.",
            },
          },
        },
        execute: async (input: {
          gravityPreset?: string;
          gravityVector?: [number, number, number];
          timeScale?: number;
          paused?: boolean;
          physicsDebug?: boolean;
        }) => {
          if (Array.isArray(input.gravityVector) && input.gravityVector.length >= 3) {
            const gv = new THREE.Vector3(
              Number(input.gravityVector[0]),
              Number(input.gravityVector[1]),
              Number(input.gravityVector[2])
            );
            setGravityField(() => gv);
          } else if (input.gravityPreset) {
            const presets: Record<string, THREE.Vector3> = {
              earth: new THREE.Vector3(0, -9.81, 0),
              moon: new THREE.Vector3(0, -1.62, 0),
              mars: new THREE.Vector3(0, -3.72, 0),
              zero_g: new THREE.Vector3(0, 0, 0),
              inverted: new THREE.Vector3(0, 4.5, 0),
            };
            if (input.gravityPreset === "default_field" && defaultGravityField) {
              setGravityField(defaultGravityField);
            } else if (presets[input.gravityPreset]) {
              const v = presets[input.gravityPreset];
              setGravityField(() => v);
            }
          }

          const patch: Record<string, unknown> = {};
          if (typeof input.timeScale === "number") {
            const clamped = Math.max(0.05, Math.min(1.5, input.timeScale));
            if (timeScaleRef) {
              (timeScaleRef as React.MutableRefObject<number>).current = clamped;
            }
            patch.slowMotion = Math.min(1, clamped);
          }
          if (typeof input.paused === "boolean") patch.pausedPhysics = input.paused;
          if (typeof input.physicsDebug === "boolean") {
            patch.physicsDebug = input.physicsDebug;
          }
          if (Object.keys(patch).length > 0) {
            usePeerStore.getState().setWorldSettingsFn?.(patch);
          }

          // Wake sleeping bodies so gravity changes take effect immediately
          world.bodies.forEach((rb) => {
            if (rb.isDynamic()) rb.wakeUp();
          });

          return { ok: true, applied: input };
        },
      },

      {
        name: "teleport_player",
        description:
          "Teleport the human player (or their currently driven vehicle) to a landmark ('simready_bay', 'origin', 'peer_bot', 'sky_drop') or explicit [x, y, z] coordinates.",
        inputSchema: {
          type: "object",
          properties: {
            landmark: {
              type: "string",
              enum: ["simready_bay", "origin", "peer_bot", "sky_drop"],
              description: "Named destination landmark.",
            },
            position: {
              type: "array",
              items: { type: "number" },
              description: "Explicit [x, y, z] coordinates.",
            },
          },
        },
        execute: async (input: {
          landmark?: string;
          position?: [number, number, number];
        }) => {
          const actor = getActiveActorBodyAndPos();
          if (!actor.body) throw new Error("Player body not mounted yet.");

          let dest: [number, number, number] = [0, 3, -78];
          if (Array.isArray(input.position) && input.position.length >= 3) {
            dest = [
              Number(input.position[0]),
              Number(input.position[1]),
              Number(input.position[2]),
            ];
          } else if (input.landmark === "origin") {
            dest = [0, 3.5, 0];
          } else if (input.landmark === "peer_bot") {
            const p = peerCurrentPosRef.current;
            dest = [p.x - 1.8, p.y, p.z];
          } else if (input.landmark === "sky_drop") {
            dest = [actor.pos.x, actor.pos.y + 28, actor.pos.z];
          }

          actor.body.setTranslation({ x: dest[0], y: dest[1], z: dest[2] }, true);
          actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          actor.body.wakeUp();

          return { ok: true, teleportedTo: dest };
        },
      },

      {
        name: "reset_sandbox",
        description:
          "Reset all SimReady OpenUSD stages to their initial state, optionally clearing Tool Gun / WebMCP spawns, and restore default gravity.",
        inputSchema: {
          type: "object",
          properties: {
            clearSpawns: {
              type: "boolean",
              description: "Also clear spawned props, rigged vehicles, and welds (default true).",
            },
          },
        },
        execute: async ({ clearSpawns = true }: { clearSpawns?: boolean }) => {
          if (clearSpawns) {
            useToolGunStore.getState().clearAllToolGunItems();
          }
          usePeerStore.getState().resetSimReadyStagesFn?.();
          if (defaultGravityField) {
            setGravityField(defaultGravityField);
          }
          if (timeScaleRef) {
            (timeScaleRef as React.MutableRefObject<number>).current = 1;
          }
          usePeerStore.getState().setWorldSettingsFn?.({
            pausedPhysics: false,
            slowMotion: 1,
          });
          return { ok: true, clearedSpawns: clearSpawns };
        },
      },
    ],
    [
      computePlacementPos,
      defaultGravityField,
      ecctrlRef,
      getActiveActorBodyAndPos,
      getGravityAtPos,
      paused,
      pickPresetDesc,
      rapier,
      setGravityField,
      timeScaleRef,
      world,
    ]
  );

  useWebMCPTools(tools);

  // Per-frame 3D Peer Bot flight + laser beam + AI Peer vehicle autopilot
  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const tNow = Date.now();
    const store = usePeerStore.getState();

    // 1. Update 3D Peer Bot position & orientation
    const actor = getActiveActorBodyAndPos();
    const desired = new THREE.Vector3();

    if (store.peerBot.followPlayer) {
      const right = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(camera.quaternion)
        .setY(0);
      if (right.lengthSq() < 0.01) right.set(1, 0, 0);
      else right.normalize();

      desired
        .copy(actor.pos)
        .addScaledVector(right, 2.2)
        .addScaledVector(actor.forward, 1.4);
      desired.y += 1.65 + Math.sin(state.clock.elapsedTime * 2.3) * 0.16;
    } else {
      desired.set(
        store.peerBot.targetPosition[0],
        store.peerBot.targetPosition[1] +
          Math.sin(state.clock.elapsedTime * 2.3) * 0.14,
        store.peerBot.targetPosition[2]
      );
    }

    peerCurrentPosRef.current.lerp(desired, Math.min(1, dt * 5.5));

    const lookPoint =
      store.peerBot.beamUntil > tNow && store.peerBot.beamTarget
        ? new THREE.Vector3(...store.peerBot.beamTarget)
        : actor.pos.clone().add(new THREE.Vector3(0, 0.5, 0));

    const lookMat = new THREE.Matrix4().lookAt(
      peerCurrentPosRef.current,
      lookPoint,
      new THREE.Vector3(0, 1, 0)
    );
    const targetQuat = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    peerCurrentQuatRef.current.slerp(targetQuat, Math.min(1, dt * 8));

    if (peerBodyRef.current) {
      peerBodyRef.current.setNextKinematicTranslation({
        x: peerCurrentPosRef.current.x,
        y: peerCurrentPosRef.current.y,
        z: peerCurrentPosRef.current.z,
      });
      peerBodyRef.current.setNextKinematicRotation({
        x: peerCurrentQuatRef.current.x,
        y: peerCurrentQuatRef.current.y,
        z: peerCurrentQuatRef.current.z,
        w: peerCurrentQuatRef.current.w,
      });
    }

    if (outerRingRef.current) {
      outerRingRef.current.rotation.z += dt * 1.8;
      outerRingRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 1.5) * 0.25;
    }

    // 2. Update Peer Bot 3D Laser Beam
    const beamOn =
      store.peerBot.beamUntil > tNow && store.peerBot.beamTarget !== null;
    if (beamLineRef.current && beamOrbRef.current) {
      beamLineRef.current.visible = beamOn;
      beamOrbRef.current.visible = beamOn;
      if (beamOn && store.peerBot.beamTarget) {
        const [bx, by, bz] = store.peerBot.beamTarget;
        const posAttr = beamGeom.attributes.position as THREE.BufferAttribute;
        posAttr.setXYZ(
          0,
          peerCurrentPosRef.current.x,
          peerCurrentPosRef.current.y,
          peerCurrentPosRef.current.z
        );
        posAttr.setXYZ(1, bx, by, bz);
        posAttr.needsUpdate = true;
        beamMat.color.set(store.peerBot.beamColor);
        beamOrbRef.current.position.set(bx, by, bz);
        (beamOrbRef.current.material as THREE.MeshBasicMaterial).color.set(
          store.peerBot.beamColor
        );
      }
    }

    // 3. Step AI Peer Vehicle Autopilots (for any vehicle the human isn't currently driving)
    const activeCtrl = useControlStore.getState().activeController;
    const dynMap = useControlStore.getState().dynamicVehicles;

    for (const [vehId, order] of Object.entries(store.autopilots)) {
      if (vehId === activeCtrl) continue;

      let handle: EcctrlVehicleHandle | null = null;
      let isDrone = false;

      if (vehId === "vehicle1") handle = vehicle1Ref.current;
      else if (vehId === "vehicle2") handle = vehicle2Ref.current;
      else if (vehId === "vehicle3") {
        handle = vehicle3Ref.current;
        isDrone = true;
      } else if (dynMap[vehId]) {
        handle = dynMap[vehId].getHandle();
        isDrone = dynMap[vehId].mode === "drone";
      }

      if (!handle || !handle.body) continue;

      if (tNow >= order.until) {
        handle.setMovement({
          forward: false,
          backward: false,
          steerLeft: false,
          steerRight: false,
          brake: true,
          throttleUp: false,
          throttleDown: false,
          yawLeft: false,
          yawRight: false,
          pitchForward: false,
          pitchBackward: false,
        });
        store.clearAutopilot(vehId);
        continue;
      }

      handle.body.wakeUp();
      const act = order.action;

      if (isDrone) {
        handle.setMovement({
          throttleUp: act === "hover_up" || act === "hover_spin" || act === "forward",
          throttleDown: act === "reverse" || act === "brake",
          yawLeft: act === "circle_left" || act === "hover_spin",
          yawRight: act === "circle_right",
          pitchForward: act === "forward" || act === "circle_left" || act === "circle_right",
          pitchBackward: act === "reverse",
        });
      } else {
        handle.setMovement({
          forward: act === "forward" || act === "circle_left" || act === "circle_right",
          backward: act === "reverse",
          steerLeft: act === "circle_left",
          steerRight: act === "circle_right",
          brake: act === "brake",
        });
      }
    }
  });

  const showBubble = Boolean(
    peerBot.speechText && peerBot.speechUntil > Date.now()
  );

  return (
    <group name="WebMCPPeerWorldGroup">
      {/* Static world anchor for world-welded WebMCP constraints */}
      <RigidBody ref={worldAnchorRef} type="fixed" colliders={false} position={[0, 0, 0]} />

      {/* 3D AI Peer Bot Companion */}
      <RigidBody
        ref={peerBodyRef}
        name="WebMCP_Peer_Bot"
        type="kinematicPosition"
        colliders={false}
        position={[2.6, 3.6, -58.5]}
      >
        <BallCollider args={[0.36]} friction={0.2} restitution={0.5} />

        {/* Central Octahedron Core */}
        <mesh castShadow>
          <octahedronGeometry args={[0.26, 1]} />
          <meshStandardMaterial
            color="#0f172a"
            emissive="#10b981"
            emissiveIntensity={0.65}
            metalness={0.85}
            roughness={0.2}
          />
        </mesh>

        {/* Forward Visor Eye */}
        <mesh position={[0, 0.03, -0.22]}>
          <boxGeometry args={[0.24, 0.08, 0.08]} />
          <meshBasicMaterial color="#38bdf8" />
        </mesh>

        {/* Gyroscopic Halo Ring */}
        <mesh ref={outerRingRef}>
          <torusGeometry args={[0.42, 0.025, 12, 32]} />
          <meshStandardMaterial
            color="#38bdf8"
            emissive="#38bdf8"
            emissiveIntensity={0.8}
            metalness={0.6}
            roughness={0.2}
          />
        </mesh>

        {/* Floating 3D Nameplate & Live Peer Speech Bubble */}
        <Html position={[0, 0.68, 0]} center distanceFactor={11} style={{ pointerEvents: "none" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              fontFamily:
                'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              userSelect: "none",
            }}
          >
            {showBubble && (
              <div
                style={{
                  maxWidth: 260,
                  padding: "6px 10px",
                  borderRadius: 10,
                  background: "rgba(15, 23, 42, 0.92)",
                  border: "1px solid #34d399",
                  color: "#f8fafc",
                  fontSize: 12,
                  lineHeight: 1.35,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
                  textAlign: "center",
                }}
              >
                {peerBot.speechText}
              </div>
            )}
            <div
              style={{
                padding: "2px 7px",
                borderRadius: 999,
                background: "rgba(15, 23, 42, 0.8)",
                border: "1px solid rgba(56, 189, 248, 0.55)",
                color: "#7dd3fc",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
              }}
            >
              ● {peerBot.speechSender || "AI PEER"} (WebMCP)
            </div>
          </div>
        </Html>
      </RigidBody>

      {/* AI Peer Action Beam */}
      <primitive
        ref={beamLineRef}
        object={beamLineObj}
        frustumCulled={false}
        visible={false}
      />
      <mesh ref={beamOrbRef} visible={false} frustumCulled={false}>
        <sphereGeometry args={[0.14, 14, 14]} />
        <meshBasicMaterial color="#34d399" transparent opacity={0.9} />
      </mesh>
    </group>
  );
}
