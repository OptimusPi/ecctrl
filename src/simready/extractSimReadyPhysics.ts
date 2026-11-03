/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import * as THREE from "three";
import type { EcctrlUserDataType } from "../shared/types";
import type {
  ExtractSimReadyOptions,
  QuaternionTuple,
  SimReadyApproximation,
  SimReadyColliderDesc,
  SimReadyJointDesc,
  SimReadyJointDrive,
  SimReadyJointType,
  SimReadyPhysicsGraph,
  SimReadyPhysicsMaterial,
  SimReadyPhysicsSceneDesc,
  SimReadyRigidBodyDesc,
  SimReadySemantics,
  USDSpecEntry,
  USDSpecsByPath,
  Vector3Tuple,
} from "./types";

const SPEC_TYPE_ATTRIBUTE = 1;
const SPEC_TYPE_PRIM = 6;
const SPEC_TYPE_RELATIONSHIP = 8;

const DEG_TO_RAD = Math.PI / 180;

const JOINT_TYPE_MAP: Record<string, SimReadyJointType> = {
  PhysicsFixedJoint: "fixed",
  PhysicsRevoluteJoint: "revolute",
  PhysicsPrismaticJoint: "prismatic",
  PhysicsSphericalJoint: "spherical",
};

const GEOM_PRIM_TYPES = new Set([
  "Mesh",
  "Cube",
  "Sphere",
  "Cylinder",
  "Cone",
  "Capsule",
]);

function toBool(val: unknown, fallback?: boolean): boolean | undefined {
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }
  return fallback;
}

function toFiniteNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "inf" || trimmed === "+inf") return Infinity;
    if (trimmed === "-inf") return -Infinity;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toNumberAllowInf(val: unknown): number | undefined {
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === "inf" || trimmed === "+inf" || trimmed === "infinity") return Infinity;
    if (trimmed === "-inf" || trimmed === "-infinity") return -Infinity;
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function toVec3Tuple(val: unknown): Vector3Tuple | undefined {
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    const arr = val as ArrayLike<unknown>;
    if (arr.length >= 3) {
      const x = Number(arr[0]);
      const y = Number(arr[1]);
      const z = Number(arr[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        return [x, y, z];
      }
    }
  }
  return undefined;
}

function toQuatTuple(val: unknown): QuaternionTuple | undefined {
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    const arr = val as ArrayLike<unknown>;
    if (arr.length >= 4) {
      const x = Number(arr[0]);
      const y = Number(arr[1]);
      const z = Number(arr[2]);
      const w = Number(arr[3]);
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(z) &&
        Number.isFinite(w)
      ) {
        return [x, y, z, w];
      }
    }
  }
  return undefined;
}

function parseStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val
      .map((item) => String(item).trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (typeof val === "string") {
    const cleaned = val.trim().replace(/^\[|\]$/g, "");
    if (!cleaned) return [];
    return cleaned
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [];
}

function cleanTargetPath(raw: string): string {
  return raw.trim().replace(/^<|>$/g, "").replace(/^["']|["']$/g, "");
}

/**
 * Collects all attributes and relationships for a given prim path from `specsByPath`.
 */
function buildStageIndex(specsByPath: USDSpecsByPath) {
  const attrsByPrim = new Map<string, Record<string, unknown>>();
  const relsByPrim = new Map<string, Record<string, string[]>>();
  const childrenByPrim = new Map<string, string[]>();

  for (const path of Object.keys(specsByPath)) {
    const spec = specsByPath[path];
    if (!spec) continue;

    if (spec.specType === SPEC_TYPE_PRIM && path !== "/") {
      const lastSlash = path.lastIndexOf("/");
      const parentPath = lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
      const remainder = path.slice(parentPath === "/" ? 1 : parentPath.length + 1);
      if (!remainder.startsWith("{") && !remainder.includes(".")) {
        let list = childrenByPrim.get(parentPath);
        if (!list) {
          list = [];
          childrenByPrim.set(parentPath, list);
        }
        list.push(path);
      }
    } else if (
      spec.specType === SPEC_TYPE_ATTRIBUTE ||
      spec.specType === SPEC_TYPE_RELATIONSHIP
    ) {
      const dotIndex = path.lastIndexOf(".");
      if (dotIndex <= 0) continue;
      const primPath = path.slice(0, dotIndex);
      const propName = path.slice(dotIndex + 1);

      if (spec.specType === SPEC_TYPE_RELATIONSHIP || Array.isArray(spec.fields.targetPaths)) {
        let relMap = relsByPrim.get(primPath);
        if (!relMap) {
          relMap = {};
          relsByPrim.set(primPath, relMap);
        }
        const rawTargets = spec.fields.targetPaths;
        if (Array.isArray(rawTargets)) {
          relMap[propName] = rawTargets.map((t) => cleanTargetPath(String(t))).filter(Boolean);
        } else if (typeof spec.fields.default === "string") {
          relMap[propName] = parseStringArray(spec.fields.default).map(cleanTargetPath).filter(Boolean);
        }
      }

      if (spec.specType === SPEC_TYPE_ATTRIBUTE) {
        let attrMap = attrsByPrim.get(primPath);
        if (!attrMap) {
          attrMap = {};
          attrsByPrim.set(primPath, attrMap);
        }
        if (spec.fields.default !== undefined) {
          attrMap[propName] = spec.fields.default;
        } else if (spec.fields.timeSamples && typeof spec.fields.timeSamples === "object") {
          const ts = spec.fields.timeSamples as { times?: number[]; values?: unknown[] };
          if (Array.isArray(ts.values) && ts.values.length > 0) {
            const zeroIdx = Array.isArray(ts.times) ? ts.times.indexOf(0) : -1;
            attrMap[propName] = zeroIdx >= 0 ? ts.values[zeroIdx] : ts.values[0];
          }
        }
      }
    }
  }

  return { attrsByPrim, relsByPrim, childrenByPrim };
}

function getApiSchemas(
  primSpec: USDSpecEntry | undefined,
  attrs: Record<string, unknown>
): string[] {
  const fromFields = parseStringArray(primSpec?.fields?.apiSchemas);
  const fromAttrs = parseStringArray(attrs["apiSchemas"]);
  if (fromFields.length === 0) return fromAttrs;
  if (fromAttrs.length === 0) return fromFields;
  return Array.from(new Set([...fromFields, ...fromAttrs]));
}

function hasApiSchema(schemas: string[], schemaBaseName: string): boolean {
  for (const s of schemas) {
    if (s === schemaBaseName || s.startsWith(schemaBaseName + ":")) return true;
  }
  return false;
}

function extractSemantics(
  attrs: Record<string, unknown>,
  schemas: string[]
): SimReadySemantics | undefined {
  const labels: Record<string, string> = {};

  // 1. Legacy Isaac Sim / Omniverse SemanticsAPI:
  //    semantics:type:<instance> = "class", semantics:data:<instance> = "pallet"
  for (const key of Object.keys(attrs)) {
    if (key.startsWith("semantics:type:")) {
      const instance = key.slice("semantics:type:".length);
      const semType = String(attrs[key] ?? "").trim();
      const semData = attrs["semantics:data:" + instance];
      if (semType && semData !== undefined) {
        labels[semType] = String(semData).trim();
      }
    } else if (key.startsWith("semantics:labels:")) {
      // 2. OpenUSD 24.08+ / SimReady SemanticsLabelsAPI:
      //    semantics:labels:wikidata_qcode = ["Q5153359"] or string
      const taxonomy = key.slice("semantics:labels:".length);
      const values = parseStringArray(attrs[key]);
      if (values.length > 0) {
        labels[taxonomy] = values.join(",");
      } else if (attrs[key] !== undefined) {
        labels[taxonomy] = String(attrs[key]).trim();
      }
    } else if (key.startsWith("simready:")) {
      const subKey = key.slice("simready:".length);
      labels[subKey] = String(attrs[key]).trim();
    }
  }

  if (Object.keys(labels).length === 0 && !hasApiSchema(schemas, "Semantics")) {
    return undefined;
  }

  let wikidataQCode: string | undefined;
  for (const [k, v] of Object.entries(labels)) {
    const qMatch = v.match(/\b(Q\d+)\b/);
    if (qMatch && (k.toLowerCase().includes("wikidata") || k.toLowerCase().includes("qcode") || /^Q\d+$/.test(v))) {
      wikidataQCode = qMatch[1];
      break;
    }
  }

  return { labels, wikidataQCode };
}

function extractEcctrlMetadata(
  attrs: Record<string, unknown>
): EcctrlUserDataType["ecctrl"] | undefined {
  const excludeRay = toBool(attrs["ecctrl:excludeRay"]);
  const excludeCharacterRay = toBool(attrs["ecctrl:excludeCharacterRay"]);
  const excludeVehicleRay = toBool(attrs["ecctrl:excludeVehicleRay"]);

  if (
    excludeRay === undefined &&
    excludeCharacterRay === undefined &&
    excludeVehicleRay === undefined
  ) {
    return undefined;
  }

  return {
    ...(excludeRay !== undefined ? { excludeRay } : {}),
    ...(excludeCharacterRay !== undefined ? { excludeCharacterRay } : {}),
    ...(excludeVehicleRay !== undefined ? { excludeVehicleRay } : {}),
  };
}

function resolvePhysicsMaterial(
  primPath: string,
  attrsByPrim: Map<string, Record<string, unknown>>,
  relsByPrim: Map<string, Record<string, string[]>>
): SimReadyPhysicsMaterial | undefined {
  const localAttrs = attrsByPrim.get(primPath) ?? {};
  const rels = relsByPrim.get(primPath) ?? {};

  // Check bound physics material first, then fallback to visual material binding
  const bindingTargets =
    rels["material:binding:physics"] ??
    rels["physics:material:binding"] ??
    rels["material:binding"] ??
    [];

  let boundMatPath: string | undefined;
  let boundAttrs: Record<string, unknown> = {};
  if (bindingTargets.length > 0) {
    boundMatPath = bindingTargets[0];
    boundAttrs = attrsByPrim.get(boundMatPath) ?? {};
  }

  const staticFriction =
    toFiniteNumber(localAttrs["physics:staticFriction"]) ??
    toFiniteNumber(boundAttrs["physics:staticFriction"]);
  const dynamicFriction =
    toFiniteNumber(localAttrs["physics:dynamicFriction"]) ??
    toFiniteNumber(boundAttrs["physics:dynamicFriction"]);
  const restitution =
    toFiniteNumber(localAttrs["physics:restitution"]) ??
    toFiniteNumber(boundAttrs["physics:restitution"]);
  const density =
    toFiniteNumber(localAttrs["physics:density"]) ??
    toFiniteNumber(boundAttrs["physics:density"]);

  if (
    staticFriction === undefined &&
    dynamicFriction === undefined &&
    restitution === undefined &&
    density === undefined
  ) {
    return undefined;
  }

  return {
    primPath: boundMatPath,
    staticFriction,
    dynamicFriction,
    restitution,
    density,
  };
}

function normalizeApproximation(raw: unknown): SimReadyApproximation {
  if (typeof raw !== "string") return "none";
  const cleaned = raw.trim();
  switch (cleaned) {
    case "convexHull":
    case "convexDecomposition":
    case "boundingCube":
    case "boundingSphere":
    case "mesh":
    case "sdf":
    case "none":
      return cleaned;
    default:
      return "none";
  }
}

function axisRotationQuat(axisToken: string): THREE.Quaternion {
  const q = new THREE.Quaternion();
  const axis = axisToken.toUpperCase();
  if (axis === "X") {
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  } else if (axis === "Z") {
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  }
  return q;
}

function axisUnitVector(axisToken: "X" | "Y" | "Z"): THREE.Vector3 {
  if (axisToken === "X") return new THREE.Vector3(1, 0, 0);
  if (axisToken === "Y") return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

/**
 * Extracts a Rapier collider descriptor from a geometric USD prim (`Cube`, `Sphere`,
 * `Cylinder`, `Cone`, `Capsule`, or `Mesh`) relative to `referenceWorldInverse`.
 */
function buildColliderFromPrim(
  primPath: string,
  typeName: string,
  attrs: Record<string, unknown>,
  obj: THREE.Object3D,
  referenceWorldInverse: THREE.Matrix4,
  inheritedApprox: SimReadyApproximation,
  isDynamicBody: boolean,
  dynamicTrimeshFallbackToHull: boolean,
  material: SimReadyPhysicsMaterial | undefined,
  kilogramsPerUnit: number,
  metersPerUnit: number,
  semantics: SimReadySemantics | undefined,
  ecctrl: EcctrlUserDataType["ecctrl"] | undefined
): SimReadyColliderDesc | null {
  const relMatrix = new THREE.Matrix4().multiplyMatrices(
    referenceWorldInverse,
    obj.matrixWorld
  );
  const relPos = new THREE.Vector3();
  const relQuat = new THREE.Quaternion();
  const relScale = new THREE.Vector3();
  relMatrix.decompose(relPos, relQuat, relScale);

  const sx = Math.abs(relScale.x);
  const sy = Math.abs(relScale.y);
  const sz = Math.abs(relScale.z);

  const localApproxRaw = attrs["physics:approximation"];
  const approximation =
    localApproxRaw !== undefined
      ? normalizeApproximation(localApproxRaw)
      : inheritedApprox;

  const rawMass = toFiniteNumber(attrs["physics:mass"]);
  const mass = rawMass !== undefined && rawMass > 0 ? rawMass * kilogramsPerUnit : undefined;
  const rawDensity =
    toFiniteNumber(attrs["physics:density"]) ?? material?.density;
  const density =
    rawDensity !== undefined && rawDensity > 0
      ? rawDensity * (kilogramsPerUnit / Math.pow(metersPerUnit, 3))
      : undefined;

  const sensor = toBool(attrs["physics:isSensor"] ?? attrs["ecctrl:sensor"]);
  const name = primPath.split("/").pop() || primPath;

  if (typeName === "Cube") {
    const size = toFiniteNumber(attrs["size"]) ?? 2;
    const half = size * 0.5;
    return {
      id: primPath,
      name,
      primPath,
      shape: "cuboid",
      approximation,
      position: [relPos.x, relPos.y, relPos.z],
      quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
      cuboidArgs: [
        Math.max(1e-4, half * sx),
        Math.max(1e-4, half * sy),
        Math.max(1e-4, half * sz),
      ],
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  if (typeName === "Sphere") {
    const radius = toFiniteNumber(attrs["radius"]) ?? 1;
    const maxScale = Math.max(sx, sy, sz);
    return {
      id: primPath,
      name,
      primPath,
      shape: "ball",
      approximation,
      position: [relPos.x, relPos.y, relPos.z],
      quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
      ballArgs: [Math.max(1e-4, radius * maxScale)],
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  if (typeName === "Cylinder" || typeName === "Cone" || typeName === "Capsule") {
    const defaultHeight = typeName === "Capsule" ? 1 : 2;
    const defaultRadius = typeName === "Capsule" ? 0.5 : 1;
    const height = toFiniteNumber(attrs["height"]) ?? defaultHeight;
    const radius = toFiniteNumber(attrs["radius"]) ?? defaultRadius;
    const axis = String(attrs["axis"] ?? "Z").toUpperCase();

    const axisScale = axis === "X" ? sx : axis === "Y" ? sy : sz;
    const radialScale =
      axis === "X"
        ? Math.max(sy, sz)
        : axis === "Y"
          ? Math.max(sx, sz)
          : Math.max(sx, sy);

    const finalQuat = relQuat.clone().multiply(axisRotationQuat(axis));
    const halfHeight = Math.max(1e-4, height * 0.5 * axisScale);
    const scaledRadius = Math.max(1e-4, radius * radialScale);

    if (typeName === "Cylinder") {
      return {
        id: primPath,
        name,
        primPath,
        shape: "cylinder",
        approximation,
        position: [relPos.x, relPos.y, relPos.z],
        quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w],
        cylinderArgs: [halfHeight, scaledRadius],
        material,
        mass,
        density,
        sensor,
        semantics,
        ecctrl,
      };
    }

    if (typeName === "Cone") {
      return {
        id: primPath,
        name,
        primPath,
        shape: "cone",
        approximation,
        position: [relPos.x, relPos.y, relPos.z],
        quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w],
        coneArgs: [halfHeight, scaledRadius],
        material,
        mass,
        density,
        sensor,
        semantics,
        ecctrl,
      };
    }

    return {
      id: primPath,
      name,
      primPath,
      shape: "capsule",
      approximation,
      position: [relPos.x, relPos.y, relPos.z],
      quaternion: [finalQuat.x, finalQuat.y, finalQuat.z, finalQuat.w],
      capsuleArgs: [halfHeight, scaledRadius],
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  // Mesh prim
  const mesh = obj as THREE.Mesh;
  const geometry = mesh.geometry;
  if (!geometry || !geometry.attributes?.position) return null;

  const posAttr = geometry.attributes.position;
  const vertCount = posAttr.count;
  if (vertCount < 3) return null;

  // Bake relative scale into vertex coordinates so Rapier receives a pure rigid frame
  const scaledVerts = new Float32Array(vertCount * 3);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (let i = 0; i < vertCount; i++) {
    const vx = posAttr.getX(i) * relScale.x;
    const vy = posAttr.getY(i) * relScale.y;
    const vz = posAttr.getZ(i) * relScale.z;
    scaledVerts[i * 3] = vx;
    scaledVerts[i * 3 + 1] = vy;
    scaledVerts[i * 3 + 2] = vz;
    if (vx < minX) minX = vx;
    if (vy < minY) minY = vy;
    if (vz < minZ) minZ = vz;
    if (vx > maxX) maxX = vx;
    if (vy > maxY) maxY = vy;
    if (vz > maxZ) maxZ = vz;
  }

  if (approximation === "boundingCube") {
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const offset = new THREE.Vector3(cx, cy, cz).applyQuaternion(relQuat).add(relPos);
    return {
      id: primPath,
      name,
      primPath,
      shape: "cuboid",
      approximation,
      position: [offset.x, offset.y, offset.z],
      quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
      cuboidArgs: [
        Math.max(1e-4, (maxX - minX) * 0.5),
        Math.max(1e-4, (maxY - minY) * 0.5),
        Math.max(1e-4, (maxZ - minZ) * 0.5),
      ],
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  if (approximation === "boundingSphere") {
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    let maxDistSq = 0;
    for (let i = 0; i < vertCount; i++) {
      const dx = scaledVerts[i * 3] - cx;
      const dy = scaledVerts[i * 3 + 1] - cy;
      const dz = scaledVerts[i * 3 + 2] - cz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > maxDistSq) maxDistSq = dSq;
    }
    const offset = new THREE.Vector3(cx, cy, cz).applyQuaternion(relQuat).add(relPos);
    return {
      id: primPath,
      name,
      primPath,
      shape: "ball",
      approximation,
      position: [offset.x, offset.y, offset.z],
      quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
      ballArgs: [Math.max(1e-4, Math.sqrt(maxDistSq))],
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  const useHull =
    approximation === "convexHull" ||
    approximation === "convexDecomposition" ||
    (isDynamicBody && dynamicTrimeshFallbackToHull);

  if (useHull) {
    return {
      id: primPath,
      name,
      primPath,
      shape: "convexHull",
      approximation,
      position: [relPos.x, relPos.y, relPos.z],
      quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
      hullVertices: scaledVerts,
      material,
      mass,
      density,
      sensor,
      semantics,
      ecctrl,
    };
  }

  // Static / kinematic exact trimesh
  let indices: Uint32Array;
  if (geometry.index) {
    const srcIdx = geometry.index.array;
    indices = new Uint32Array(srcIdx.length);
    for (let i = 0; i < srcIdx.length; i++) indices[i] = srcIdx[i];
  } else {
    indices = new Uint32Array(vertCount);
    for (let i = 0; i < vertCount; i++) indices[i] = i;
  }

  // Flip winding if odd number of negative scale axes
  const negAxes =
    (relScale.x < 0 ? 1 : 0) + (relScale.y < 0 ? 1 : 0) + (relScale.z < 0 ? 1 : 0);
  if (negAxes % 2 === 1) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
  }

  return {
    id: primPath,
    name,
    primPath,
    shape: "trimesh",
    approximation,
    position: [relPos.x, relPos.y, relPos.z],
    quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
    trimeshArgs: [scaledVerts, indices],
    material,
    mass,
    density,
    sensor,
    semantics,
    ecctrl,
  };
}

/**
 * Clones visual meshes inside `sourceObj` into `targetParent`, skipping nested independent
 * rigidBody prims (`skipRigidBodyPaths`) and hiding `purpose = "guide"` / `visibility = "invisible"`
 * collision proxy geometry.
 */
function cloneVisualSubtree(
  sourceObj: THREE.Object3D,
  referenceWorldInverse: THREE.Matrix4,
  skipRigidBodyPaths: Set<string>,
  rootPrimPath: string,
  castShadow: boolean,
  receiveShadow: boolean
): THREE.Group {
  const container = new THREE.Group();
  container.name = (rootPrimPath.split("/").pop() || "Visual") + "_Visual";

  const visit = (node: THREE.Object3D) => {
    const nodePrimPath = node.userData?.usdPrimPath as string | undefined;
    if (
      nodePrimPath &&
      nodePrimPath !== rootPrimPath &&
      skipRigidBodyPaths.has(nodePrimPath)
    ) {
      return;
    }

    const purpose = node.userData?.usdPurpose as string | undefined;
    const visibility = node.userData?.usdVisibility as string | undefined;
    if (purpose === "guide" || purpose === "proxy" || visibility === "invisible") {
      return;
    }

    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const clonedMesh = (mesh as THREE.SkinnedMesh).isSkinnedMesh
        ? mesh.clone(false)
        : new THREE.Mesh(mesh.geometry, mesh.material);
      clonedMesh.name = mesh.name;
      clonedMesh.castShadow = castShadow;
      clonedMesh.receiveShadow = receiveShadow;
      clonedMesh.userData = { ...mesh.userData };

      const relMatrix = new THREE.Matrix4().multiplyMatrices(
        referenceWorldInverse,
        mesh.matrixWorld
      );
      relMatrix.decompose(
        clonedMesh.position,
        clonedMesh.quaternion,
        clonedMesh.scale
      );
      container.add(clonedMesh);
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  visit(sourceObj);
  return container;
}

/**
 * Compiles a composed Three.js USD group + `specsByPath` dictionary into a complete
 * `SimReadyPhysicsGraph` (`UsdPhysics` rigid bodies, colliders, materials, joints, drives,
 * `PhysicsScene` gravity, and SimReady semantic labels/Q-codes).
 */
export function extractSimReadyPhysics(
  composedGroup: THREE.Group,
  specsByPath: USDSpecsByPath,
  options: ExtractSimReadyOptions = {}
): SimReadyPhysicsGraph {
  const {
    dynamicTrimeshFallbackToHull = true,
    castShadow = true,
    receiveShadow = true,
  } = options;

  composedGroup.updateMatrixWorld(true);

  const rootSpec = specsByPath["/"];
  const rootFields = rootSpec?.fields ?? {};
  const upAxis: "Y" | "Z" = rootFields.upAxis === "Z" ? "Z" : "Y";
  const metersPerUnit =
    typeof rootFields.metersPerUnit === "number" && rootFields.metersPerUnit > 0
      ? rootFields.metersPerUnit
      : 1;
  const kilogramsPerUnit =
    typeof rootFields.kilogramsPerUnit === "number" && rootFields.kilogramsPerUnit > 0
      ? rootFields.kilogramsPerUnit
      : 1;

  // Stage-level rotation converting USD stage vectors into Three.js Y-up space
  const stageUpRotation = new THREE.Quaternion();
  if (upAxis === "Z") {
    stageUpRotation.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  }

  const { attrsByPrim, relsByPrim, childrenByPrim } = buildStageIndex(specsByPath);

  // Map primPath -> composed Object3D
  const objectByPrimPath = new Map<string, THREE.Object3D>();
  objectByPrimPath.set("/", composedGroup);
  composedGroup.traverse((obj) => {
    const primPath = obj.userData?.usdPrimPath as string | undefined;
    if (primPath && !objectByPrimPath.has(primPath)) {
      objectByPrimPath.set(primPath, obj);
    }
  });

  const semanticsByPath: Record<string, SimReadySemantics> = {};
  const rigidBodyPaths = new Set<string>();
  let physicsScene: SimReadyPhysicsSceneDesc | null = null;

  // Pass 1: Discover PhysicsScene, Semantics, and enabled PhysicsRigidBodyAPI prims
  for (const primPath of Object.keys(specsByPath)) {
    const spec = specsByPath[primPath];
    if (!spec || spec.specType !== SPEC_TYPE_PRIM || primPath === "/") continue;

    const attrs = attrsByPrim.get(primPath) ?? {};
    const schemas = getApiSchemas(spec, attrs);
    const typeName = String(spec.fields.typeName ?? "");

    const semantics = extractSemantics(attrs, schemas);
    if (semantics) {
      semanticsByPath[primPath] = semantics;
    }

    if (typeName === "PhysicsScene" && !physicsScene) {
      const rawDir =
        toVec3Tuple(attrs["physics:gravityDirection"]) ??
        (upAxis === "Z" ? [0, 0, -1] : [0, -1, 0]);
      const dirVec = new THREE.Vector3(rawDir[0], rawDir[1], rawDir[2]);
      if (dirVec.lengthSq() < 1e-8) {
        dirVec.set(0, -1, 0);
      } else {
        dirVec.applyQuaternion(stageUpRotation).normalize();
      }

      const rawMag = toFiniteNumber(attrs["physics:gravityMagnitude"]);
      // Per UsdPhysics spec, negative/omitted gravityMagnitude defaults to 9.81 m/s^2
      const gravityMagnitude =
        rawMag !== undefined && rawMag >= 0 ? rawMag * metersPerUnit : 9.81;
      const gravVec = dirVec.clone().multiplyScalar(gravityMagnitude);

      physicsScene = {
        primPath,
        gravityDirection: [dirVec.x, dirVec.y, dirVec.z],
        gravityMagnitude,
        gravityVector: [gravVec.x, gravVec.y, gravVec.z],
      };
    }

    const hasRBSchema = hasApiSchema(schemas, "PhysicsRigidBodyAPI");
    const explicitRBEnabled = toBool(attrs["physics:rigidBodyEnabled"]);
    const isRigidBody =
      explicitRBEnabled === true || (hasRBSchema && explicitRBEnabled !== false);

    if (isRigidBody && objectByPrimPath.has(primPath)) {
      rigidBodyPaths.add(primPath);
    }
  }

  // Helper to collect colliders within a subtree (stopping at nested rigid bodies)
  const collectCollidersInSubtree = (
    startPath: string,
    referenceWorldInverse: THREE.Matrix4,
    isDynamicBody: boolean,
    inheritedCollisionEnabled: boolean,
    inheritedApprox: SimReadyApproximation,
    inheritedMaterial: SimReadyPhysicsMaterial | undefined,
    out: SimReadyColliderDesc[]
  ) => {
    const walk = (
      currentPath: string,
      collActive: boolean,
      approx: SimReadyApproximation,
      mat: SimReadyPhysicsMaterial | undefined
    ) => {
      if (currentPath !== startPath && rigidBodyPaths.has(currentPath)) {
        return;
      }

      const spec = specsByPath[currentPath];
      if (!spec || spec.specType !== SPEC_TYPE_PRIM) return;

      const attrs = attrsByPrim.get(currentPath) ?? {};
      const schemas = getApiSchemas(spec, attrs);
      const typeName = String(spec.fields.typeName ?? "");

      const hasCollSchema =
        hasApiSchema(schemas, "PhysicsCollisionAPI") ||
        hasApiSchema(schemas, "PhysicsMeshCollisionAPI");
      const explicitCollEnabled = toBool(attrs["physics:collisionEnabled"]);

      let nextCollActive = collActive;
      if (explicitCollEnabled === false) {
        nextCollActive = false;
      } else if (explicitCollEnabled === true || hasCollSchema) {
        nextCollActive = true;
      }

      const nextApprox =
        attrs["physics:approximation"] !== undefined
          ? normalizeApproximation(attrs["physics:approximation"])
          : approx;

      const localMat = resolvePhysicsMaterial(currentPath, attrsByPrim, relsByPrim);
      const nextMat = localMat
        ? { ...mat, ...Object.fromEntries(Object.entries(localMat).filter(([, v]) => v !== undefined)) }
        : mat;

      if (nextCollActive && GEOM_PRIM_TYPES.has(typeName)) {
        const obj = objectByPrimPath.get(currentPath);
        if (obj) {
          const collider = buildColliderFromPrim(
            currentPath,
            typeName,
            attrs,
            obj,
            referenceWorldInverse,
            nextApprox,
            isDynamicBody,
            dynamicTrimeshFallbackToHull,
            nextMat,
            kilogramsPerUnit,
            metersPerUnit,
            semanticsByPath[currentPath],
            extractEcctrlMetadata(attrs)
          );
          if (collider) {
            out.push(collider);
          }
        }
      }

      const children = childrenByPrim.get(currentPath);
      if (children) {
        for (const childPath of children) {
          walk(childPath, nextCollActive, nextApprox, nextMat);
        }
      }
    };

    walk(startPath, inheritedCollisionEnabled, inheritedApprox, inheritedMaterial);
  };

  // Pass 2: Build RigidBody descriptors
  const rigidBodies: SimReadyRigidBodyDesc[] = [];
  const rigidBodyTransforms = new Map<
    string,
    { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }
  >();

  for (const rbPath of rigidBodyPaths) {
    const obj = objectByPrimPath.get(rbPath)!;
    const spec = specsByPath[rbPath];
    const attrs = attrsByPrim.get(rbPath) ?? {};
    const schemas = getApiSchemas(spec, attrs);

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    obj.matrixWorld.decompose(worldPos, worldQuat, worldScale);

    rigidBodyTransforms.set(rbPath, {
      pos: worldPos.clone(),
      quat: worldQuat.clone(),
      scale: worldScale.clone(),
    });

    // Rigid frame inverse (unit scale so collider dimensions bake worldScale cleanly!)
    const rigidWorldMatrix = new THREE.Matrix4().compose(
      worldPos,
      worldQuat,
      new THREE.Vector3(1, 1, 1)
    );
    const rigidWorldInverse = rigidWorldMatrix.clone().invert();

    const kinematic = toBool(attrs["physics:kinematicEnabled"], false) === true;
    const bodyType = kinematic ? "kinematicPosition" : "dynamic";
    const isDynamic = bodyType === "dynamic";

    const rbMaterial = resolvePhysicsMaterial(rbPath, attrsByPrim, relsByPrim);
    const colliders: SimReadyColliderDesc[] = [];

    collectCollidersInSubtree(
      rbPath,
      rigidWorldInverse,
      isDynamic,
      false,
      "convexHull",
      rbMaterial,
      colliders
    );

    // Fallback: if a RigidBodyAPI prim has visual meshes but forgot explicit CollisionAPI on children,
    // generate convexHull colliders from its visual meshes so it doesn't fall through the floor.
    if (colliders.length === 0) {
      collectCollidersInSubtree(
        rbPath,
        rigidWorldInverse,
        isDynamic,
        true,
        "convexHull",
        rbMaterial,
        colliders
      );
    }

    const visualGroup = cloneVisualSubtree(
      obj,
      rigidWorldInverse,
      rigidBodyPaths,
      rbPath,
      castShadow,
      receiveShadow
    );

    const rawVel = toVec3Tuple(attrs["physics:velocity"]);
    let linearVelocity: Vector3Tuple | undefined;
    if (rawVel) {
      const v = new THREE.Vector3(rawVel[0], rawVel[1], rawVel[2])
        .applyQuaternion(stageUpRotation)
        .multiplyScalar(metersPerUnit);
      linearVelocity = [v.x, v.y, v.z];
    }

    // UsdPhysics specifies physics:angularVelocity in degrees/second in stage space
    const rawAngVel = toVec3Tuple(attrs["physics:angularVelocity"]);
    let angularVelocity: Vector3Tuple | undefined;
    if (rawAngVel) {
      const w = new THREE.Vector3(rawAngVel[0], rawAngVel[1], rawAngVel[2])
        .multiplyScalar(DEG_TO_RAD)
        .applyQuaternion(stageUpRotation);
      angularVelocity = [w.x, w.y, w.z];
    }

    const rawMass = toFiniteNumber(attrs["physics:mass"]);
    const mass = rawMass !== undefined && rawMass > 0 ? rawMass * kilogramsPerUnit : undefined;

    const rawDensity =
      toFiniteNumber(attrs["physics:density"]) ?? rbMaterial?.density;
    const density =
      rawDensity !== undefined && rawDensity > 0
        ? rawDensity * (kilogramsPerUnit / Math.pow(metersPerUnit, 3))
        : undefined;

    const rawCoM = toVec3Tuple(attrs["physics:centerOfMass"]);
    const centerOfMass: Vector3Tuple | undefined = rawCoM
      ? [
          rawCoM[0] * worldScale.x,
          rawCoM[1] * worldScale.y,
          rawCoM[2] * worldScale.z,
        ]
      : undefined;

    const rawInertia = toVec3Tuple(attrs["physics:diagonalInertia"]);
    const inertiaScale = kilogramsPerUnit * Math.pow(metersPerUnit, 2);
    const diagonalInertia: Vector3Tuple | undefined = rawInertia
      ? [
          rawInertia[0] * inertiaScale,
          rawInertia[1] * inertiaScale,
          rawInertia[2] * inertiaScale,
        ]
      : undefined;

    const principalAxes = toQuatTuple(attrs["physics:principalAxes"]);
    const startsAsleep = toBool(attrs["physics:startsAsleep"]);

    // Propagate semantics from ancestors if child rigidBody has none directly
    let semantics = semanticsByPath[rbPath];
    if (!semantics) {
      let parentCheck = rbPath.slice(0, rbPath.lastIndexOf("/"));
      while (parentCheck.length > 0) {
        if (semanticsByPath[parentCheck]) {
          semantics = semanticsByPath[parentCheck];
          break;
        }
        parentCheck = parentCheck.slice(0, parentCheck.lastIndexOf("/"));
      }
    }

    rigidBodies.push({
      id: rbPath,
      name: rbPath.split("/").pop() || rbPath,
      primPath: rbPath,
      bodyType,
      position: [worldPos.x, worldPos.y, worldPos.z],
      quaternion: [worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w],
      linearVelocity,
      angularVelocity,
      startsAsleep,
      mass,
      density,
      centerOfMass,
      diagonalInertia,
      principalAxes,
      material: rbMaterial,
      colliders,
      visualGroup,
      apiSchemas: schemas,
      semantics,
      ecctrl: extractEcctrlMetadata(attrs),
    });
  }

  // Pass 3: Static environment colliders & static visuals (prims outside any RigidBodyAPI)
  const identityInverse = new THREE.Matrix4();
  const staticColliders: SimReadyColliderDesc[] = [];
  const rootChildren = childrenByPrim.get("/") ?? [];
  for (const topChild of rootChildren) {
    if (rigidBodyPaths.has(topChild)) continue;
    collectCollidersInSubtree(
      topChild,
      identityInverse,
      false,
      false,
      "none",
      undefined,
      staticColliders
    );
  }

  const staticVisualGroup = cloneVisualSubtree(
    composedGroup,
    identityInverse,
    rigidBodyPaths,
    "/",
    castShadow,
    receiveShadow
  );

  // Pass 4: Extract UsdPhysics Joints (`PhysicsFixedJoint`, `PhysicsRevoluteJoint`,
  // `PhysicsPrismaticJoint`, `PhysicsSphericalJoint`) + `PhysicsLimitAPI` + `PhysicsDriveAPI`
  const joints: SimReadyJointDesc[] = [];

  const resolveJointEndpoint = (
    targetPath: string | null,
    rawLocalPos: Vector3Tuple,
    rawLocalRot: QuaternionTuple
  ): {
    rbPath: string | null;
    anchor: Vector3Tuple;
    rot: QuaternionTuple;
    worldAnchor: THREE.Vector3;
    worldRot: THREE.Quaternion;
  } => {
    const localRotQ = new THREE.Quaternion(
      rawLocalRot[0],
      rawLocalRot[1],
      rawLocalRot[2],
      rawLocalRot[3]
    ).normalize();

    if (targetPath && rigidBodyTransforms.has(targetPath)) {
      const rbTf = rigidBodyTransforms.get(targetPath)!;
      const scaledAnchor = new THREE.Vector3(
        rawLocalPos[0] * rbTf.scale.x,
        rawLocalPos[1] * rbTf.scale.y,
        rawLocalPos[2] * rbTf.scale.z
      );
      const worldAnchor = scaledAnchor
        .clone()
        .applyQuaternion(rbTf.quat)
        .add(rbTf.pos);
      const worldRot = rbTf.quat.clone().multiply(localRotQ);
      return {
        rbPath: targetPath,
        anchor: [scaledAnchor.x, scaledAnchor.y, scaledAnchor.z],
        rot: [localRotQ.x, localRotQ.y, localRotQ.z, localRotQ.w],
        worldAnchor,
        worldRot,
      };
    }

    // Static world prim (or omitted body target -> stage root '/')
    const refObj = (targetPath && objectByPrimPath.get(targetPath)) || composedGroup;
    const refPos = new THREE.Vector3();
    const refQuat = new THREE.Quaternion();
    const refScale = new THREE.Vector3();
    refObj.matrixWorld.decompose(refPos, refQuat, refScale);

    const worldAnchor = new THREE.Vector3(
      rawLocalPos[0] * refScale.x,
      rawLocalPos[1] * refScale.y,
      rawLocalPos[2] * refScale.z
    )
      .applyQuaternion(refQuat)
      .add(refPos);
    const worldRot = refQuat.clone().multiply(localRotQ);

    return {
      rbPath: null,
      anchor: [worldAnchor.x, worldAnchor.y, worldAnchor.z],
      rot: [worldRot.x, worldRot.y, worldRot.z, worldRot.w],
      worldAnchor,
      worldRot,
    };
  };

  for (const primPath of Object.keys(specsByPath)) {
    const spec = specsByPath[primPath];
    if (!spec || spec.specType !== SPEC_TYPE_PRIM) continue;

    const typeName = String(spec.fields.typeName ?? "");
    const jointType = JOINT_TYPE_MAP[typeName];
    if (!jointType) continue;

    const attrs = attrsByPrim.get(primPath) ?? {};
    const rels = relsByPrim.get(primPath) ?? {};

    const enabled = toBool(attrs["physics:jointEnabled"], true) !== false;
    const collisionEnabled = toBool(attrs["physics:collisionEnabled"], false) === true;

    const body0Rel = rels["physics:body0"]?.[0] ?? null;
    const body1Rel = rels["physics:body1"]?.[0] ?? null;

    const rawPos0 = toVec3Tuple(attrs["physics:localPos0"]) ?? [0, 0, 0];
    const rawRot0 = toQuatTuple(attrs["physics:localRot0"]) ?? [0, 0, 0, 1];
    const rawPos1 = toVec3Tuple(attrs["physics:localPos1"]) ?? [0, 0, 0];
    const rawRot1 = toQuatTuple(attrs["physics:localRot1"]) ?? [0, 0, 0, 1];

    const ep0 = resolveJointEndpoint(body0Rel, rawPos0, rawRot0);
    const ep1 = resolveJointEndpoint(body1Rel, rawPos1, rawRot1);

    // At least one endpoint must be a simulated RigidBody
    if (!ep0.rbPath && !ep1.rbPath) continue;

    const rawAxis = String(attrs["physics:axis"] ?? "X").toUpperCase();
    const axis: "X" | "Y" | "Z" =
      rawAxis === "Y" ? "Y" : rawAxis === "Z" ? "Z" : "X";

    // Limits (`PhysicsLimitAPI` or direct `physics:lowerLimit` / `physics:upperLimit`)
    let limits: [number, number] | undefined;
    const lowerRaw =
      toNumberAllowInf(attrs["physics:lowerLimit"]) ??
      toNumberAllowInf(attrs[`limit:${axis === "X" ? "rotX" : axis === "Y" ? "rotY" : "rotZ"}:physics:low`]) ??
      toNumberAllowInf(attrs["limit:angular:physics:low"]) ??
      toNumberAllowInf(attrs["limit:linear:physics:low"]);
    const upperRaw =
      toNumberAllowInf(attrs["physics:upperLimit"]) ??
      toNumberAllowInf(attrs[`limit:${axis === "X" ? "rotX" : axis === "Y" ? "rotY" : "rotZ"}:physics:high`]) ??
      toNumberAllowInf(attrs["limit:angular:physics:high"]) ??
      toNumberAllowInf(attrs["limit:linear:physics:high"]);

    if (
      lowerRaw !== undefined &&
      upperRaw !== undefined &&
      Number.isFinite(lowerRaw) &&
      Number.isFinite(upperRaw)
    ) {
      if (jointType === "revolute") {
        limits = [lowerRaw * DEG_TO_RAD, upperRaw * DEG_TO_RAD];
      } else if (jointType === "prismatic") {
        limits = [lowerRaw * metersPerUnit, upperRaw * metersPerUnit];
      }
    }

    // Drives (`PhysicsDriveAPI:angular` for revolute, `PhysicsDriveAPI:linear` for prismatic)
    const drivePrefix =
      jointType === "revolute" ? "drive:angular:physics:" : "drive:linear:physics:";
    const stiffness = toFiniteNumber(attrs[drivePrefix + "stiffness"]);
    const damping = toFiniteNumber(attrs[drivePrefix + "damping"]);
    const rawTargetPos = toFiniteNumber(attrs[drivePrefix + "targetPosition"]);
    const rawTargetVel = toFiniteNumber(attrs[drivePrefix + "targetVelocity"]);
    const maxForce = toFiniteNumber(attrs[drivePrefix + "maxForce"]);
    const driveTypeRaw = attrs[drivePrefix + "type"];

    let drive: SimReadyJointDrive | undefined;
    if (
      stiffness !== undefined ||
      damping !== undefined ||
      rawTargetPos !== undefined ||
      rawTargetVel !== undefined
    ) {
      const unitScale = jointType === "revolute" ? DEG_TO_RAD : metersPerUnit;
      drive = {
        driveType: driveTypeRaw === "acceleration" ? "acceleration" : "force",
        targetPosition:
          rawTargetPos !== undefined ? rawTargetPos * unitScale : undefined,
        targetVelocity:
          rawTargetVel !== undefined ? rawTargetVel * unitScale : undefined,
        stiffness,
        damping,
        maxForce,
      };
    }

    joints.push({
      id: primPath,
      name: primPath.split("/").pop() || primPath,
      primPath,
      jointType,
      enabled,
      collisionEnabled,
      body0Path: ep0.rbPath,
      body1Path: ep1.rbPath,
      localPos0: ep0.anchor,
      localRot0: ep0.rot,
      localPos1: ep1.anchor,
      localRot1: ep1.rot,
      axis,
      limits,
      drive,
    });
  }

  // Silence unused helper warning while keeping axisUnitVector available if needed
  void axisUnitVector;

  return {
    upAxis,
    metersPerUnit,
    kilogramsPerUnit,
    physicsScene,
    staticVisualGroup,
    staticColliders,
    rigidBodies,
    joints,
    semanticsByPath,
  };
}
