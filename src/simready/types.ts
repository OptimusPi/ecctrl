/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import type * as THREE from "three";
import type { ImpulseJoint } from "@dimforge/rapier3d-compat";
import type { RapierRigidBody, RigidBodyProps } from "@react-three/rapier";
import type { ReactNode, RefObject } from "react";
import type { EcctrlUserDataType } from "../shared/types";
import type { CarConfigType, DroneConfigType, EcctrlVehicleProps } from "../vehicles/EcctrlVehicle";

export type Vector3Tuple = [x: number, y: number, z: number];
export type QuaternionTuple = [x: number, y: number, z: number, w: number];

/**
 * Raw USD spec entry produced by Three.js USDAParser / USDCParser.
 */
export interface USDSpecEntry {
  specType: number;
  fields: Record<string, unknown>;
}

export type USDSpecsByPath = Record<string, USDSpecEntry>;

/**
 * OpenUSD UsdPhysics collision approximation tokens.
 */
export type SimReadyApproximation =
  | "none"
  | "mesh"
  | "convexHull"
  | "convexDecomposition"
  | "boundingCube"
  | "boundingSphere"
  | "sdf";

/**
 * SimReady / OpenUSD SemanticsAPI metadata attached to a prim.
 */
export interface SimReadySemantics {
  /** Key-value map of semantic type -> semantic data (e.g. `{ class: "pallet", wikidata_qcode: "Q5153359" }`). */
  labels: Record<string, string>;
  /** Convenience Wikidata Q-code if present on the prim (e.g. `"Q5153359"`). */
  wikidataQCode?: string;
}

/**
 * Resolved UsdPhysics material properties (`PhysicsMaterialAPI`).
 */
export interface SimReadyPhysicsMaterial {
  primPath?: string;
  staticFriction?: number;
  dynamicFriction?: number;
  restitution?: number;
  density?: number;
}

export type SimReadyColliderShape =
  | "cuboid"
  | "ball"
  | "cylinder"
  | "cone"
  | "capsule"
  | "convexHull"
  | "trimesh";

/**
 * Extracted collider descriptor in its parent RigidBody's local coordinate space
 * (or stage-root space for static environment colliders).
 */
export interface SimReadyColliderDesc {
  id: string;
  name: string;
  primPath: string;
  shape: SimReadyColliderShape;
  approximation: SimReadyApproximation;
  position: Vector3Tuple;
  quaternion: QuaternionTuple;
  cuboidArgs?: [halfWidth: number, halfHeight: number, halfDepth: number];
  ballArgs?: [radius: number];
  cylinderArgs?: [halfHeight: number, radius: number];
  coneArgs?: [halfHeight: number, radius: number];
  capsuleArgs?: [halfHeight: number, radius: number];
  hullVertices?: Float32Array;
  trimeshArgs?: [vertices: Float32Array, indices: Uint32Array];
  material?: SimReadyPhysicsMaterial;
  mass?: number;
  density?: number;
  sensor?: boolean;
  semantics?: SimReadySemantics;
  ecctrl?: EcctrlUserDataType["ecctrl"];
}

/**
 * Extracted RigidBody descriptor from `PhysicsRigidBodyAPI` (or static collision group).
 */
export interface SimReadyRigidBodyDesc {
  id: string;
  name: string;
  primPath: string;
  bodyType: "dynamic" | "kinematicPosition" | "fixed";
  position: Vector3Tuple;
  quaternion: QuaternionTuple;
  linearVelocity?: Vector3Tuple;
  angularVelocity?: Vector3Tuple;
  startsAsleep?: boolean;
  mass?: number;
  density?: number;
  centerOfMass?: Vector3Tuple;
  diagonalInertia?: Vector3Tuple;
  principalAxes?: QuaternionTuple;
  material?: SimReadyPhysicsMaterial;
  colliders: SimReadyColliderDesc[];
  /** Detached visual Object3D subtree expressed in this RigidBody's local frame. */
  visualGroup: THREE.Group;
  apiSchemas: string[];
  semantics?: SimReadySemantics;
  ecctrl?: EcctrlUserDataType["ecctrl"];
}

export type SimReadyJointType = "fixed" | "revolute" | "prismatic" | "spherical";

/**
 * Extracted `PhysicsDriveAPI` motor parameters (converted to SI / radians).
 */
export interface SimReadyJointDrive {
  driveType?: "force" | "acceleration";
  targetPosition?: number;
  targetVelocity?: number;
  stiffness?: number;
  damping?: number;
  maxForce?: number;
}

/**
 * Extracted `UsdPhysics` joint descriptor (`PhysicsFixedJoint`, `PhysicsRevoluteJoint`,
 * `PhysicsPrismaticJoint`, `PhysicsSphericalJoint`).
 */
export interface SimReadyJointDesc {
  id: string;
  name: string;
  primPath: string;
  jointType: SimReadyJointType;
  enabled: boolean;
  collisionEnabled: boolean;
  /** Prim path of body0, or `null` if anchored to the static world frame. */
  body0Path: string | null;
  /** Prim path of body1, or `null` if anchored to the static world frame. */
  body1Path: string | null;
  /** Local anchor on body0 in Three.js/Rapier meters. */
  localPos0: Vector3Tuple;
  /** Local frame orientation on body0 `[x, y, z, w]`. */
  localRot0: QuaternionTuple;
  /** Local anchor on body1 in Three.js/Rapier meters. */
  localPos1: Vector3Tuple;
  /** Local frame orientation on body1 `[x, y, z, w]`. */
  localRot1: QuaternionTuple;
  /** Joint primary axis token in the joint's local frame. */
  axis: "X" | "Y" | "Z";
  /** Lower/upper limits (radians for revolute, meters for prismatic). */
  limits?: [lower: number, upper: number];
  /** Optional `PhysicsDriveAPI` motor configuration. */
  drive?: SimReadyJointDrive;
}

/**
 * Extracted `PhysicsScene` prim metadata (converted to Three.js Y-up meters/s²).
 */
export interface SimReadyPhysicsSceneDesc {
  primPath: string;
  gravityDirection: Vector3Tuple;
  gravityMagnitude: number;
  gravityVector: Vector3Tuple;
}

/**
 * Complete compiled SimReady physics & semantics graph for an OpenUSD stage.
 */
export interface SimReadyPhysicsGraph {
  upAxis: "Y" | "Z";
  metersPerUnit: number;
  kilogramsPerUnit: number;
  physicsScene: SimReadyPhysicsSceneDesc | null;
  /** Visual subtree for non-simulated static environment meshes. */
  staticVisualGroup: THREE.Group;
  /** Static environment colliders (`PhysicsCollisionAPI` without an ancestor `PhysicsRigidBodyAPI`). */
  staticColliders: SimReadyColliderDesc[];
  /** Independent simulated rigid bodies (`PhysicsRigidBodyAPI`). */
  rigidBodies: SimReadyRigidBodyDesc[];
  /** Physics joints & articulations connecting rigid bodies or world anchors. */
  joints: SimReadyJointDesc[];
  /** Lookup of semantic metadata indexed by USD prim path. */
  semanticsByPath: Record<string, SimReadySemantics>;
}

/**
 * Loaded SimReady USD asset returned by `SimReadyUSDLoader` and `useSimReadyUSD`.
 */
export interface SimReadyUSDAsset {
  /** Raw composed Three.js Group (with `usdPrimPath` annotations and guide meshes hidden). */
  group: THREE.Group;
  /** Root layer `specsByPath` dictionary. */
  specsByPath: USDSpecsByPath;
  /** Parsed sublayer/reference `specsByPath` dictionaries keyed by archive path. */
  sublayerSpecs: Record<string, USDSpecsByPath>;
  upAxis: "Y" | "Z";
  metersPerUnit: number;
  kilogramsPerUnit: number;
  /** Extracted `UsdPhysics` + SimReady semantics graph ready for Rapier & Ecctrl. */
  physics: SimReadyPhysicsGraph;
}

export interface ExtractSimReadyOptions {
  /**
   * Default friction applied when a collider has no `PhysicsMaterialAPI`.
   * @default 0.6
   */
  defaultFriction?: number;
  /**
   * Default restitution applied when a collider has no `PhysicsMaterialAPI`.
   * @default 0.05
   */
  defaultRestitution?: number;
  /**
   * Automatically convert `"none"` / `"mesh"` approximations on dynamic rigid bodies
   * to `"convexHull"` (per SimReady validation rules and Rapier dynamic stability).
   * @default true
   */
  dynamicTrimeshFallbackToHull?: boolean;
  /**
   * Enable `castShadow` on visual meshes.
   * @default true
   */
  castShadow?: boolean;
  /**
   * Enable `receiveShadow` on visual meshes.
   * @default true
   */
  receiveShadow?: boolean;
}

export interface SimReadyStageHandle {
  readonly asset: SimReadyUSDAsset;
  readonly physics: SimReadyPhysicsGraph;
  readonly bodies: ReadonlyMap<string, RapierRigidBody>;
  readonly joints: ReadonlyMap<string, ImpulseJoint>;
  getBody: (primPath: string) => RapierRigidBody | undefined;
  getBodiesBySemantic: (labelOrQCode: string) => RapierRigidBody[];
  /** Dynamically hide/unmount or re-enable a single USD RigidBody prim (e.g. when upgrading a prop into a live vehicle). */
  setBodyEnabled: (primPath: string, enabled: boolean) => void;
  /** Resets all dynamic and kinematic rigid bodies to their authored OpenUSD transforms, types, and velocities. */
  reset: () => void;
}

export interface SimReadyStageProps extends Omit<ExtractSimReadyOptions, "dynamicTrimeshFallbackToHull"> {
  /** URL to `.usd`, `.usda`, `.usdc`, or `.usdz` file (loaded via pure-JS `SimReadyUSDLoader`, no COOP/SAB required). */
  url?: string;
  /** Pre-parsed `SimReadyUSDAsset` (alternative to `url`). */
  asset?: SimReadyUSDAsset;
  /** Stage root position in Three.js world space. */
  position?: Vector3Tuple;
  /** Stage root Euler rotation `[x, y, z]` in radians. */
  rotation?: Vector3Tuple;
  /** Uniform scale multiplier applied to the entire stage (including physics bodies, colliders, and joint anchors). */
  scale?: number;
  /** Apply Ecctrl's `useCustomGravity` field to all dynamic SimReady rigid bodies each frame. */
  enableCustomGravity?: boolean;
  /** Sync the USD stage's `PhysicsScene` gravity vector into Ecctrl's `useCustomGravity` store on mount. */
  syncPhysicsSceneGravity?: boolean;
  /** Pause custom gravity impulses (pair with Ecctrl `TimeControl`). */
  paused?: boolean;
  /** Time scale number or ref (pair with Ecctrl `TimeControl`). */
  timeScale?: number | RefObject<number>;
  /** Extra props forwarded to dynamic `<RigidBody>` instances (e.g. `ccd`, `linearDamping`). */
  rigidBodyProps?: Partial<RigidBodyProps>;
  /** Callback fired once rigid bodies are mounted. */
  onReady?: (handle: SimReadyStageHandle) => void;
}

export interface SimReadyColliderGroupProps {
  /** URL to `.usd`, `.usda`, `.usdc`, or `.usdz` file. */
  url?: string;
  /** Pre-parsed `SimReadyUSDAsset` (alternative to `url`). */
  asset?: SimReadyUSDAsset;
  /** Optional specific USD prim path to mount (defaults to the first rigid body or stage colliders). */
  primPath?: string;
  /** Scale multiplier applied to visual meshes and collider shapes. */
  scale?: number;
  /** Render the visual meshes alongside the colliders. @default true */
  renderVisuals?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/**
 * Local-space bounding box and mass summary for a SimReady USD asset or RigidBody prim.
 */
export interface SimReadyBounds {
  min: Vector3Tuple;
  max: Vector3Tuple;
  size: Vector3Tuple;
  center: Vector3Tuple;
  halfExtents: Vector3Tuple;
  estimatedMass: number;
}

/**
 * Props for `SimReadyVehicleRig`, which auto-wires any SimReady OpenUSD asset or `SimReadyRigidBodyDesc`
 * into a drivable `<EcctrlVehicle>` with mass-scaled `ShapeCastWheel`s (`"car"`) or `ThrustPropeller`s (`"drone"`).
 */
export interface SimReadyVehicleRigProps extends Omit<EcctrlVehicleProps, "children"> {
  /** URL to `.usd`, `.usda`, `.usdc`, or `.usdz` file. */
  url?: string;
  /** Pre-parsed `SimReadyUSDAsset`. */
  asset?: SimReadyUSDAsset;
  /** Direct `SimReadyRigidBodyDesc` (e.g. extracted from a live stage body hit by a Tool Gun). */
  rigidBodyDesc?: SimReadyRigidBodyDesc;
  /** Specific USD prim path to rig when `url` or `asset` contains multiple rigid bodies. */
  primPath?: string;
  /** Controller rig mode: 4-wheel `ShapeCastWheel` car or 4-rotor `ThrustPropeller` quadcopter. @default "car" */
  mode?: "car" | "drone";
  /** Uniform scale multiplier applied to the SimReady chassis visuals, colliders, and wheel/rotor layout. @default 1 */
  scale?: number;
  /** Pause wheel/propeller updates (pair with `TimeControl`). @default false */
  paused?: boolean;
  /** Optional custom visual node rendered inside each `ShapeCastWheel` (defaults to a procedural tire mesh). */
  wheelModel?: ReactNode;
  /** Optional custom visual node rendered inside each `ThrustPropeller` (defaults to a procedural rotor mesh). */
  propellerModel?: ReactNode;
  /** Override auto-computed `CarConfigType` fields. */
  carConfig?: Partial<CarConfigType>;
  /** Override auto-computed `DroneConfigType` fields. */
  droneConfig?: Partial<DroneConfigType>;
  /** Extra children mounted inside `<EcctrlVehicle>` (such as an interaction sensor collider). */
  children?: ReactNode;
}
