/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import * as THREE from "three";
import React, {
  createRef,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useFrame } from "@react-three/fiber";
import {
  BallCollider,
  CapsuleCollider,
  ConeCollider,
  ConvexHullCollider,
  CuboidCollider,
  CylinderCollider,
  RigidBody,
  TrimeshCollider,
  useImpulseJoint,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import type { ImpulseJoint, UnitImpulseJoint } from "@dimforge/rapier3d-compat";
import { useCustomGravity } from "../gravity/useCustomGravity";
import type { ForwardRefComponent } from "../shared/types";
import { useSimReadyUSD } from "./SimReadyUSDLoader";
import type {
  QuaternionTuple,
  SimReadyColliderDesc,
  SimReadyColliderGroupProps,
  SimReadyJointDesc,
  SimReadyPhysicsMaterial,
  SimReadyRigidBodyDesc,
  SimReadyStageHandle,
  SimReadyStageProps,
  SimReadyUSDAsset,
  Vector3Tuple,
} from "./types";

const readTimeScale = (value: number | RefObject<number> | undefined): number => {
  if (value === undefined) return 1;
  return typeof value === "number" ? value : value.current;
};

function scaleFloat32(src: Float32Array, s: number): Float32Array {
  if (s === 1) return src;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] * s;
  return out;
}

interface ColliderMassAllocation {
  mass?: number;
  density?: number;
  massProperties?: {
    mass: number;
    centerOfMass: { x: number; y: number; z: number };
    principalAngularInertia: { x: number; y: number; z: number };
    angularInertiaLocalFrame: { x: number; y: number; z: number; w: number };
  };
}

/**
 * Renders a single extracted `SimReadyColliderDesc` as the matching Rapier collider component.
 */
export function SimReadyColliderItem({
  collider,
  scale = 1,
  bodyMaterial,
  defaultFriction = 0.6,
  defaultRestitution = 0.05,
  massAllocation,
}: {
  collider: SimReadyColliderDesc;
  scale?: number;
  bodyMaterial?: SimReadyPhysicsMaterial;
  defaultFriction?: number;
  defaultRestitution?: number;
  massAllocation?: ColliderMassAllocation;
}) {
  const position: Vector3Tuple = useMemo(
    () => [
      collider.position[0] * scale,
      collider.position[1] * scale,
      collider.position[2] * scale,
    ],
    [collider.position, scale]
  );

  const quaternion = useMemo(
    () =>
      new THREE.Quaternion(
        collider.quaternion[0],
        collider.quaternion[1],
        collider.quaternion[2],
        collider.quaternion[3]
      ),
    [collider.quaternion]
  );

  const friction =
    collider.material?.dynamicFriction ??
    collider.material?.staticFriction ??
    bodyMaterial?.dynamicFriction ??
    bodyMaterial?.staticFriction ??
    defaultFriction;

  const restitution =
    collider.material?.restitution ??
    bodyMaterial?.restitution ??
    defaultRestitution;

  const scaledHull = useMemo(
    () =>
      collider.hullVertices
        ? scaleFloat32(collider.hullVertices, scale)
        : undefined,
    [collider.hullVertices, scale]
  );

  const scaledTrimesh = useMemo(
    () =>
      collider.trimeshArgs
        ? ([
            scaleFloat32(collider.trimeshArgs[0], scale),
            collider.trimeshArgs[1],
          ] as [Float32Array, Uint32Array])
        : undefined,
    [collider.trimeshArgs, scale]
  );

  const sharedProps = {
    name: collider.name,
    position,
    quaternion,
    friction,
    restitution,
    ...(collider.sensor !== undefined ? { sensor: collider.sensor } : {}),
    ...(massAllocation?.massProperties
      ? { massProperties: massAllocation.massProperties }
      : massAllocation?.mass !== undefined
        ? { mass: massAllocation.mass }
        : massAllocation?.density !== undefined
          ? { density: massAllocation.density }
          : {}),
  };

  switch (collider.shape) {
    case "cuboid":
      if (!collider.cuboidArgs) return null;
      return (
        <CuboidCollider
          {...sharedProps}
          args={[
            collider.cuboidArgs[0] * scale,
            collider.cuboidArgs[1] * scale,
            collider.cuboidArgs[2] * scale,
          ]}
        />
      );
    case "ball":
      if (!collider.ballArgs) return null;
      return (
        <BallCollider {...sharedProps} args={[collider.ballArgs[0] * scale]} />
      );
    case "cylinder":
      if (!collider.cylinderArgs) return null;
      return (
        <CylinderCollider
          {...sharedProps}
          args={[
            collider.cylinderArgs[0] * scale,
            collider.cylinderArgs[1] * scale,
          ]}
        />
      );
    case "cone":
      if (!collider.coneArgs) return null;
      return (
        <ConeCollider
          {...sharedProps}
          args={[collider.coneArgs[0] * scale, collider.coneArgs[1] * scale]}
        />
      );
    case "capsule":
      if (!collider.capsuleArgs) return null;
      return (
        <CapsuleCollider
          {...sharedProps}
          args={[
            collider.capsuleArgs[0] * scale,
            collider.capsuleArgs[1] * scale,
          ]}
        />
      );
    case "convexHull":
      if (!scaledHull) return null;
      return <ConvexHullCollider {...sharedProps} args={[scaledHull]} />;
    case "trimesh":
      if (!scaledTrimesh) return null;
      return <TrimeshCollider {...sharedProps} args={scaledTrimesh} />;
    default:
      return null;
  }
}

/**
 * Computes mutually-exclusive Rapier mass/density/massProperties per collider on a RigidBody
 * so compound colliders sum to the exact authored `PhysicsMassAPI` mass without double-counting.
 */
export function buildColliderMassAllocations(
  body: SimReadyRigidBodyDesc,
  scale: number
): ColliderMassAllocation[] {
  const count = body.colliders.length;
  if (count === 0) return [];

  if (body.bodyType !== "dynamic") {
    return body.colliders.map(() => ({}));
  }

  const massScale = Math.pow(scale, 3);
  const inertiaScale = Math.pow(scale, 5);

  if (body.mass !== undefined && body.mass > 0) {
    const totalMass = body.mass * massScale;

    if (body.centerOfMass && body.diagonalInertia) {
      const pa = body.principalAxes ?? [0, 0, 0, 1];
      return body.colliders.map((_, idx) =>
        idx === 0
          ? {
              massProperties: {
                mass: totalMass,
                centerOfMass: {
                  x: body.centerOfMass![0] * scale,
                  y: body.centerOfMass![1] * scale,
                  z: body.centerOfMass![2] * scale,
                },
                principalAngularInertia: {
                  x: body.diagonalInertia![0] * inertiaScale,
                  y: body.diagonalInertia![1] * inertiaScale,
                  z: body.diagonalInertia![2] * inertiaScale,
                },
                angularInertiaLocalFrame: {
                  x: pa[0],
                  y: pa[1],
                  z: pa[2],
                  w: pa[3],
                },
              },
            }
          : { mass: 0 }
      );
    }

    const perColliderMass = totalMass / count;
    return body.colliders.map(() => ({ mass: perColliderMass }));
  }

  return body.colliders.map((c) => {
    if (c.mass !== undefined && c.mass > 0) {
      return { mass: c.mass * massScale };
    }
    const d = c.density ?? body.density;
    if (d !== undefined && d > 0) {
      return { density: d };
    }
    return {};
  });
}

function getLocalAxisVec(
  axisToken: "X" | "Y" | "Z",
  rotTuple: QuaternionTuple
): THREE.Vector3 {
  const base =
    axisToken === "X"
      ? new THREE.Vector3(1, 0, 0)
      : axisToken === "Y"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion(
    rotTuple[0],
    rotTuple[1],
    rotTuple[2],
    rotTuple[3]
  ).normalize();
  return base.applyQuaternion(q).normalize();
}

/**
 * Instantiates a single `UsdPhysics` joint (`Fixed`, `Revolute`, `Prismatic`, `Spherical`)
 * in Rapier, including `PhysicsLimitAPI` bounds, `PhysicsDriveAPI` motors, and contact filtering.
 */
function SimReadyJointItem({
  joint,
  body0Ref,
  body1Ref,
  anchor0Override,
  anchor1Override,
  localRotForAxis,
  scale = 1,
  onJointMounted,
}: {
  joint: SimReadyJointDesc;
  body0Ref: RefObject<RapierRigidBody | null>;
  body1Ref: RefObject<RapierRigidBody | null>;
  anchor0Override?: Vector3Tuple;
  anchor1Override?: Vector3Tuple;
  localRotForAxis?: QuaternionTuple;
  scale?: number;
  onJointMounted: (primPath: string, instance: ImpulseJoint | undefined) => void;
}) {
  const { rapier } = useRapier();

  const jointData = useMemo(() => {
    const a0Src = anchor0Override ?? joint.localPos0;
    const a1Src = anchor1Override ?? joint.localPos1;

    const a0 = {
      x: a0Src[0] * scale,
      y: a0Src[1] * scale,
      z: a0Src[2] * scale,
    };
    const a1 = {
      x: a1Src[0] * scale,
      y: a1Src[1] * scale,
      z: a1Src[2] * scale,
    };

    if (joint.jointType === "fixed") {
      const f0 = {
        x: joint.localRot0[0],
        y: joint.localRot0[1],
        z: joint.localRot0[2],
        w: joint.localRot0[3],
      };
      const f1 = {
        x: joint.localRot1[0],
        y: joint.localRot1[1],
        z: joint.localRot1[2],
        w: joint.localRot1[3],
      };
      return rapier.JointData.fixed(a0, f0, a1, f1);
    }

    if (joint.jointType === "spherical") {
      return rapier.JointData.spherical(a0, a1);
    }

    const axisVec = getLocalAxisVec(
      joint.axis,
      localRotForAxis ?? joint.localRot0
    );
    const axis = { x: axisVec.x, y: axisVec.y, z: axisVec.z };

    if (joint.jointType === "prismatic") {
      const data = rapier.JointData.prismatic(a0, a1, axis);
      if (joint.limits) {
        data.limitsEnabled = true;
        data.limits = [joint.limits[0] * scale, joint.limits[1] * scale];
      }
      return data;
    }

    const data = rapier.JointData.revolute(a0, a1, axis);
    if (joint.limits) {
      data.limitsEnabled = true;
      data.limits = [joint.limits[0], joint.limits[1]];
    }
    return data;
  }, [
    anchor0Override,
    anchor1Override,
    joint,
    localRotForAxis,
    rapier,
    scale,
  ]);

  const jointRef = useImpulseJoint(
    body0Ref as RefObject<RapierRigidBody>,
    body1Ref as RefObject<RapierRigidBody>,
    jointData
  );

  useEffect(() => {
    const instance = jointRef.current;
    onJointMounted(joint.primPath, instance);
    if (!instance) return;

    instance.setContactsEnabled(joint.collisionEnabled);

    if (joint.jointType === "revolute" || joint.jointType === "prismatic") {
      const unitJoint = instance as UnitImpulseJoint;

      if (joint.limits) {
        const min =
          joint.jointType === "prismatic"
            ? joint.limits[0] * scale
            : joint.limits[0];
        const max =
          joint.jointType === "prismatic"
            ? joint.limits[1] * scale
            : joint.limits[1];
        unitJoint.setLimits(min, max);
      }

      if (joint.drive) {
        const {
          driveType,
          targetPosition,
          targetVelocity,
          stiffness = 0,
          damping = 0,
        } = joint.drive;

        unitJoint.configureMotorModel(
          driveType === "acceleration"
            ? rapier.MotorModel.AccelerationBased
            : rapier.MotorModel.ForceBased
        );

        const scaledTargetPos =
          targetPosition !== undefined
            ? joint.jointType === "prismatic"
              ? targetPosition * scale
              : targetPosition
            : 0;
        const scaledTargetVel =
          targetVelocity !== undefined
            ? joint.jointType === "prismatic"
              ? targetVelocity * scale
              : targetVelocity
            : 0;

        if (stiffness > 0) {
          unitJoint.configureMotor(
            scaledTargetPos,
            scaledTargetVel,
            stiffness,
            damping
          );
        } else if (damping > 0 || scaledTargetVel !== 0) {
          unitJoint.configureMotorVelocity(
            scaledTargetVel,
            damping > 0 ? damping : 10
          );
        }
      }
    }

    return () => {
      onJointMounted(joint.primPath, undefined);
    };
  }, [joint, jointRef, onJointMounted, rapier, scale]);

  return null;
}

/**
 * Internal renderer given a resolved `SimReadyUSDAsset`.
 */
const SimReadyStageResolved = forwardRef<
  SimReadyStageHandle,
  Omit<SimReadyStageProps, "url"> & { asset: SimReadyUSDAsset }
>(
  (
    {
      asset,
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      scale = 1,
      defaultFriction = 0.6,
      defaultRestitution = 0.05,
      castShadow = true,
      receiveShadow = true,
      enableCustomGravity = false,
      syncPhysicsSceneGravity = false,
      paused = false,
      timeScale = 1,
      rigidBodyProps,
      onReady,
    },
    ref
  ) => {
    const { physics } = asset;
    const { rapier, world } = useRapier();

    const applyGravityField = useCustomGravity((s) => s.applyGravityField);
    const setGravityField = useCustomGravity((s) => s.setGravityField);

    const stageGroupRef = useRef<THREE.Group>(null);
    const liveBodiesMap = useRef<Map<string, RapierRigidBody>>(new Map());
    const liveJointsMap = useRef<Map<string, ImpulseJoint>>(new Map());
    const [disabledPaths, setDisabledPaths] = useState<Set<string>>(() => new Set());

    const setBodyEnabled = useCallback((primPath: string, enabled: boolean) => {
      setDisabledPaths((prev) => {
        const has = prev.has(primPath);
        if (enabled && !has) return prev;
        if (!enabled && has) return prev;
        const next = new Set(prev);
        if (enabled) next.delete(primPath);
        else next.add(primPath);
        return next;
      });
    }, []);

    // Clone visual groups per stage instance so multiple <SimReadyStage> instances can share one cached asset
    const clonedStaticVisual = useMemo(() => {
      const cloned = physics.staticVisualGroup.clone(true);
      cloned.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = castShadow;
          obj.receiveShadow = receiveShadow;
        }
      });
      return cloned;
    }, [physics.staticVisualGroup, castShadow, receiveShadow]);

    const bodyEntries = useMemo(
      () =>
        physics.rigidBodies.map((rb) => {
          const visual = rb.visualGroup.clone(true);
          visual.traverse((obj) => {
            if ((obj as THREE.Mesh).isMesh) {
              obj.castShadow = castShadow;
              obj.receiveShadow = receiveShadow;
            }
          });
          return {
            desc: rb,
            ref: createRef<RapierRigidBody>(),
            visual,
            massAllocations: buildColliderMassAllocations(rb, scale),
          };
        }),
      [physics.rigidBodies, castShadow, receiveShadow, scale]
    );

    const bodyEntryByPath = useMemo(() => {
      const map = new Map<string, (typeof bodyEntries)[number]>();
      for (const entry of bodyEntries) {
        map.set(entry.desc.primPath, entry);
      }
      return map;
    }, [bodyEntries]);

    // Build dedicated fixed world-anchor bodies for joints that attach to the static world
    // with orientation matching the dynamic partner body so revolute/prismatic rest frames align at angle = 0
    const resolvedJoints = useMemo(() => {
      return physics.joints
        .filter((j) => j.enabled)
        .map((j) => {
          const b0Entry = j.body0Path ? bodyEntryByPath.get(j.body0Path) : undefined;
          const b1Entry = j.body1Path ? bodyEntryByPath.get(j.body1Path) : undefined;

          if (b0Entry && b1Entry) {
            return {
              joint: j,
              body0Ref: b0Entry.ref,
              body1Ref: b1Entry.ref,
              worldAnchorBody: null as null | {
                ref: RefObject<RapierRigidBody | null>;
                position: Vector3Tuple;
                quaternion: QuaternionTuple;
              },
              anchor0Override: undefined as Vector3Tuple | undefined,
              anchor1Override: undefined as Vector3Tuple | undefined,
              localRotForAxis: j.localRot0,
            };
          }

          if (!b0Entry && b1Entry) {
            const worldRef = createRef<RapierRigidBody>();
            return {
              joint: j,
              body0Ref: worldRef,
              body1Ref: b1Entry.ref,
              worldAnchorBody: {
                ref: worldRef,
                position: j.localPos0,
                quaternion:
                  j.jointType === "fixed" ? [0, 0, 0, 1] : b1Entry.desc.quaternion,
              },
              anchor0Override:
                j.jointType === "fixed"
                  ? j.localPos0
                  : ([0, 0, 0] as Vector3Tuple),
              anchor1Override: j.localPos1,
              localRotForAxis: j.localRot1,
            };
          }

          if (b0Entry && !b1Entry) {
            const worldRef = createRef<RapierRigidBody>();
            return {
              joint: j,
              body0Ref: b0Entry.ref,
              body1Ref: worldRef,
              worldAnchorBody: {
                ref: worldRef,
                position: j.localPos1,
                quaternion:
                  j.jointType === "fixed" ? [0, 0, 0, 1] : b0Entry.desc.quaternion,
              },
              anchor0Override: j.localPos0,
              anchor1Override:
                j.jointType === "fixed"
                  ? j.localPos1
                  : ([0, 0, 0] as Vector3Tuple),
              localRotForAxis: j.localRot0,
            };
          }

          return null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
    }, [physics.joints, bodyEntryByPath]);

    // Sync USD PhysicsScene gravity into Ecctrl's useCustomGravity if requested
    useEffect(() => {
      if (!syncPhysicsSceneGravity || !physics.physicsScene) return;
      const [gx, gy, gz] = physics.physicsScene.gravityVector;
      const gVec = new THREE.Vector3(gx, gy, gz);
      setGravityField(() => gVec);
    }, [syncPhysicsSceneGravity, physics.physicsScene, setGravityField]);

    // Maintain live Map of RapierRigidBody handles
    useEffect(() => {
      const map = liveBodiesMap.current;
      map.clear();
      for (const entry of bodyEntries) {
        if (entry.ref.current) {
          map.set(entry.desc.primPath, entry.ref.current);
        }
      }
    }, [bodyEntries]);

    const handleJointMounted = useCallback(
      (primPath: string, instance: ImpulseJoint | undefined) => {
        if (instance) liveJointsMap.current.set(primPath, instance);
        else liveJointsMap.current.delete(primPath);
      },
      []
    );

    // Apply Ecctrl custom gravity per dynamic body on each frame when enabled
    useFrame(() => {
      if (!enableCustomGravity || paused) return;
      const ts = readTimeScale(timeScale);
      if (ts <= 0) return;
      for (const entry of bodyEntries) {
        if (
          entry.desc.bodyType === "dynamic" &&
          entry.ref.current &&
          entry.ref.current.isDynamic()
        ) {
          applyGravityField(entry.ref.current, world.timestep);
        }
      }
    });

    const reset = useCallback(() => {
      setDisabledPaths((prev) => (prev.size > 0 ? new Set() : prev));
      stageGroupRef.current?.updateMatrixWorld(true);
      const stageMatrix = stageGroupRef.current
        ? stageGroupRef.current.matrixWorld
        : new THREE.Matrix4();
      const stagePos = new THREE.Vector3();
      const stageQuat = new THREE.Quaternion();
      const stageScl = new THREE.Vector3();
      stageMatrix.decompose(stagePos, stageQuat, stageScl);

      for (const entry of bodyEntries) {
        const rb = entry.ref.current;
        if (!rb) continue;

        const targetBodyType =
          entry.desc.bodyType === "kinematicPosition"
            ? rapier.RigidBodyType.KinematicPositionBased
            : rapier.RigidBodyType.Dynamic;
        if (rb.bodyType() !== targetBodyType) {
          rb.setBodyType(targetBodyType, true);
        }

        const localP = new THREE.Vector3(
          entry.desc.position[0] * scale,
          entry.desc.position[1] * scale,
          entry.desc.position[2] * scale
        )
          .applyQuaternion(stageQuat)
          .add(stagePos);

        const localQ = new THREE.Quaternion(
          entry.desc.quaternion[0],
          entry.desc.quaternion[1],
          entry.desc.quaternion[2],
          entry.desc.quaternion[3]
        ).premultiply(stageQuat);

        rb.setTranslation({ x: localP.x, y: localP.y, z: localP.z }, true);
        rb.setRotation(
          { x: localQ.x, y: localQ.y, z: localQ.z, w: localQ.w },
          true
        );

        const lv = entry.desc.linearVelocity ?? [0, 0, 0];
        const av = entry.desc.angularVelocity ?? [0, 0, 0];
        const worldLv = new THREE.Vector3(lv[0], lv[1], lv[2]).applyQuaternion(
          stageQuat
        );
        const worldAv = new THREE.Vector3(av[0], av[1], av[2]).applyQuaternion(
          stageQuat
        );
        rb.setLinvel({ x: worldLv.x, y: worldLv.y, z: worldLv.z }, true);
        rb.setAngvel({ x: worldAv.x, y: worldAv.y, z: worldAv.z }, true);
      }
    }, [bodyEntries, rapier, scale]);

    const handleObject = useMemo<SimReadyStageHandle>(
      () => ({
        get asset() {
          return asset;
        },
        get physics() {
          return physics;
        },
        get bodies() {
          return liveBodiesMap.current;
        },
        get joints() {
          return liveJointsMap.current;
        },
        getBody: (primPath: string) => liveBodiesMap.current.get(primPath),
        getBodiesBySemantic: (query: string) => {
          const needle = query.trim().toLowerCase();
          const matches: RapierRigidBody[] = [];
          for (const entry of bodyEntries) {
            const rb = entry.ref.current;
            const sem = entry.desc.semantics;
            if (!rb || !sem) continue;
            if (sem.wikidataQCode?.toLowerCase() === needle) {
              matches.push(rb);
              continue;
            }
            for (const [k, v] of Object.entries(sem.labels)) {
              if (
                k.toLowerCase() === needle ||
                v.toLowerCase().includes(needle)
              ) {
                matches.push(rb);
                break;
              }
            }
          }
          return matches;
        },
        setBodyEnabled,
        reset,
      }),
      [asset, physics, bodyEntries, setBodyEnabled, reset]
    );

    useImperativeHandle(ref, () => handleObject, [handleObject]);

    useEffect(() => {
      onReady?.(handleObject);
    }, [handleObject, onReady]);

    return (
      <group ref={stageGroupRef} position={position} rotation={rotation}>
        {/* Static non-simulated USD visuals */}
        <primitive object={clonedStaticVisual} scale={scale} />

        {/* Static environment UsdPhysics colliders */}
        {physics.staticColliders.length > 0 && (
          <RigidBody
            type="fixed"
            colliders={false}
            userData={{ simReady: { primPath: "/", staticEnvironment: true } }}
          >
            {physics.staticColliders.map((c) => (
              <SimReadyColliderItem
                key={c.id}
                collider={c}
                scale={scale}
                defaultFriction={defaultFriction}
                defaultRestitution={defaultRestitution}
              />
            ))}
          </RigidBody>
        )}

        {/* Fixed world-anchor bodies for world-hinged/sliding/pendulum UsdPhysics joints */}
        {resolvedJoints.map((rj) => {
          const jointDisabled =
            (rj.joint.body0Path && disabledPaths.has(rj.joint.body0Path)) ||
            (rj.joint.body1Path && disabledPaths.has(rj.joint.body1Path));
          if (jointDisabled || !rj.worldAnchorBody) return null;
          return (
            <RigidBody
              key={`world-anchor-${rj.joint.id}`}
              ref={rj.worldAnchorBody.ref}
              type="fixed"
              colliders={false}
              position={
                rj.joint.jointType === "fixed"
                  ? [0, 0, 0]
                  : [
                      rj.worldAnchorBody.position[0] * scale,
                      rj.worldAnchorBody.position[1] * scale,
                      rj.worldAnchorBody.position[2] * scale,
                    ]
              }
              quaternion={
                new THREE.Quaternion(
                  rj.worldAnchorBody.quaternion[0],
                  rj.worldAnchorBody.quaternion[1],
                  rj.worldAnchorBody.quaternion[2],
                  rj.worldAnchorBody.quaternion[3]
                )
              }
            />
          );
        })}

        {/* Simulated Dynamic & Kinematic RigidBodies from PhysicsRigidBodyAPI */}
        {bodyEntries.map(({ desc, ref: rbRef, visual, massAllocations }) => {
          if (disabledPaths.has(desc.primPath)) return null;
          const quat = new THREE.Quaternion(
            desc.quaternion[0],
            desc.quaternion[1],
            desc.quaternion[2],
            desc.quaternion[3]
          );

          return (
            <RigidBody
              key={desc.id}
              ref={(instance) => {
                (rbRef as React.MutableRefObject<RapierRigidBody | null>).current =
                  instance;
                if (instance) {
                  liveBodiesMap.current.set(desc.primPath, instance);
                  if (desc.startsAsleep) instance.sleep();
                } else {
                  liveBodiesMap.current.delete(desc.primPath);
                }
              }}
              name={desc.name}
              type={desc.bodyType}
              colliders={false}
              position={[
                desc.position[0] * scale,
                desc.position[1] * scale,
                desc.position[2] * scale,
              ]}
              quaternion={quat}
              {...(desc.linearVelocity
                ? { linearVelocity: desc.linearVelocity }
                : {})}
              {...(desc.angularVelocity
                ? { angularVelocity: desc.angularVelocity }
                : {})}
              userData={{
                ...(desc.ecctrl ? { ecctrl: desc.ecctrl } : {}),
                simReady: {
                  primPath: desc.primPath,
                  name: desc.name,
                  apiSchemas: desc.apiSchemas,
                  semantics: desc.semantics,
                  desc,
                  scale,
                  retireBody: () => setBodyEnabled(desc.primPath, false),
                },
              }}
              {...rigidBodyProps}
            >
              <primitive object={visual} scale={scale} />
              {desc.colliders.map((c, idx) => (
                <SimReadyColliderItem
                  key={c.id}
                  collider={c}
                  scale={scale}
                  bodyMaterial={desc.material}
                  defaultFriction={defaultFriction}
                  defaultRestitution={defaultRestitution}
                  massAllocation={massAllocations[idx]}
                />
              ))}
            </RigidBody>
          );
        })}

        {/* UsdPhysics Joints & Articulations */}
        {resolvedJoints.map((rj) => {
          const jointDisabled =
            (rj.joint.body0Path && disabledPaths.has(rj.joint.body0Path)) ||
            (rj.joint.body1Path && disabledPaths.has(rj.joint.body1Path));
          if (jointDisabled) return null;
          return (
            <SimReadyJointItem
              key={rj.joint.id}
              joint={rj.joint}
              body0Ref={rj.body0Ref}
              body1Ref={rj.body1Ref}
              anchor0Override={rj.anchor0Override}
              anchor1Override={rj.anchor1Override}
              localRotForAxis={rj.localRotForAxis}
              scale={scale}
              onJointMounted={handleJointMounted}
            />
          );
        })}
      </group>
    );
  }
);

const SimReadyStageFromUrl = forwardRef<
  SimReadyStageHandle,
  Omit<SimReadyStageProps, "asset"> & { url: string }
>(({ url, ...rest }, ref) => {
  const loaded = useSimReadyUSD(url);
  return <SimReadyStageResolved ref={ref} asset={loaded} {...rest} />;
});

/**
 * Mounts an OpenUSD / NVIDIA SimReady `.usd`, `.usda`, `.usdc`, or `.usdz` stage
 * with full `UsdPhysics` rigid bodies, collision approximations, materials, joints, drives,
 * semantic Q-code queries, and Ecctrl custom-gravity support — zero COOP/COEP or `SharedArrayBuffer`.
 */
export const SimReadyStage: ForwardRefComponent<
  SimReadyStageProps,
  SimReadyStageHandle
> = /* @__PURE__ */ forwardRef<SimReadyStageHandle, SimReadyStageProps>(
  ({ url, asset, ...rest }, ref) => {
    if (asset) {
      return <SimReadyStageResolved ref={ref} asset={asset} {...rest} />;
    }
    if (url) {
      return <SimReadyStageFromUrl ref={ref} url={url} {...rest} />;
    }
    throw new Error("SimReadyStage requires either a `url` or `asset` prop.");
  }
);

function SimReadyColliderGroupResolved({
  asset,
  primPath,
  scale = 1,
  renderVisuals = true,
  castShadow = true,
  receiveShadow = true,
}: Omit<SimReadyColliderGroupProps, "url"> & { asset: SimReadyUSDAsset }) {
  const targetBody = useMemo(() => {
    if (primPath) {
      return asset.physics.rigidBodies.find((b) => b.primPath === primPath);
    }
    return asset.physics.rigidBodies[0];
  }, [asset, primPath]);

  const colliders = targetBody
    ? targetBody.colliders
    : asset.physics.staticColliders;

  const massAllocations = useMemo(
    () => (targetBody ? buildColliderMassAllocations(targetBody, scale) : []),
    [targetBody, scale]
  );

  const visualClone = useMemo(() => {
    if (!renderVisuals) return null;
    const src = targetBody
      ? targetBody.visualGroup
      : asset.physics.staticVisualGroup;
    const clone = src.clone(true);
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = castShadow;
        obj.receiveShadow = receiveShadow;
      }
    });
    return clone;
  }, [asset, targetBody, renderVisuals, castShadow, receiveShadow]);

  return (
    <>
      {visualClone && <primitive object={visualClone} scale={scale} />}
      {colliders.map((c, idx) => (
        <SimReadyColliderItem
          key={c.id}
          collider={c}
          scale={scale}
          bodyMaterial={targetBody?.material}
          massAllocation={massAllocations[idx]}
        />
      ))}
    </>
  );
}

function SimReadyColliderGroupFromUrl({
  url,
  ...rest
}: Omit<SimReadyColliderGroupProps, "asset"> & { url: string }) {
  const loaded = useSimReadyUSD(url);
  return <SimReadyColliderGroupResolved asset={loaded} {...rest} />;
}

/**
 * Mounts a SimReady OpenUSD asset's visual meshes and `UsdPhysics` compound colliders
 * directly inside an existing `<EcctrlVehicle>`, `<Ecctrl>`, or `<RigidBody>`.
 */
export function SimReadyColliderGroup({
  url,
  asset,
  ...rest
}: SimReadyColliderGroupProps) {
  if (asset) {
    return <SimReadyColliderGroupResolved asset={asset} {...rest} />;
  }
  if (url) {
    return <SimReadyColliderGroupFromUrl url={url} {...rest} />;
  }
  throw new Error(
    "SimReadyColliderGroup requires either a `url` or `asset` prop."
  );
}
