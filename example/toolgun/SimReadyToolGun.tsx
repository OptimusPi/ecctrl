import * as THREE from "three";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BallCollider,
  RigidBody,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import {
  QueryFilterFlags,
  type ImpulseJoint,
  type UnitImpulseJoint,
} from "@dimforge/rapier3d-compat";
import { useCustomGravity } from "../../src/gravity";
import type { EcctrlHandle } from "../../src";
import type { EcctrlVehicleHandle } from "../../src/vehicle";
import type { EcctrlCameraControlsHandle } from "../../src/camera";
import {
  computeSimReadyBounds,
  SimReadyVehicleRig,
  useSimReadyUSD,
  type SimReadyRigidBodyDesc,
} from "../../src/simready";
import {
  buildColliderMassAllocations,
  SimReadyColliderItem,
} from "../../src/simready/SimReadyStage";
import { useControlStore } from "../store/useControlStore";
import {
  useToolGunStore,
  type RiggedSimReadyVehicleItem,
  type SpawnedSimReadyProp,
} from "./useToolGunStore";

interface SimReadyBodyUserData {
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

interface ActiveWeldRecord {
  id: string;
  joint: ImpulseJoint;
  body0Handle: number;
  body1Handle: number;
  localAnchor0: THREE.Vector3;
  localAnchor1: THREE.Vector3;
  color: string;
}

interface PendingWeldAnchor {
  bodyHandle: number;
  localAnchor: THREE.Vector3;
  localNormal: THREE.Vector3;
  worldPoint: THREE.Vector3;
  label: string;
}

let nextEntityCounter = 1;

function SpawnedSimReadyPropInstance({
  item,
  paused,
}: {
  item: SpawnedSimReadyProp;
  paused: boolean;
}) {
  const rbRef = useRef<RapierRigidBody>(null);
  const { world } = useRapier();
  const applyGravityField = useCustomGravity((s) => s.applyGravityField);
  const removeSpawnedProp = useToolGunStore((s) => s.removeSpawnedProp);

  const visual = useMemo(() => {
    const clone = item.desc.visualGroup.clone(true);
    clone.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return clone;
  }, [item.desc.visualGroup]);

  const massAllocations = useMemo(
    () => buildColliderMassAllocations(item.desc, 1),
    [item.desc]
  );

  const quat = useMemo(
    () =>
      new THREE.Quaternion(
        item.quaternion[0],
        item.quaternion[1],
        item.quaternion[2],
        item.quaternion[3]
      ),
    [item.quaternion]
  );

  useFrame(() => {
    if (paused || !rbRef.current || !rbRef.current.isDynamic()) return;
    applyGravityField(rbRef.current, world.timestep);
  });

  return (
    <RigidBody
      ref={rbRef}
      name={item.label}
      type="dynamic"
      colliders={false}
      position={item.position}
      quaternion={quat}
      userData={{
        simReady: {
          primPath: item.desc.primPath,
          name: item.label,
          semantics: item.desc.semantics,
          desc: item.desc,
          isSpawnedProp: true,
          spawnId: item.id,
          retireBody: () => removeSpawnedProp(item.id),
        } satisfies SimReadyBodyUserData,
      }}
    >
      <primitive object={visual} />
      {item.desc.colliders.map((c, idx) => (
        <SimReadyColliderItem
          key={c.id}
          collider={c}
          scale={1}
          bodyMaterial={item.desc.material}
          massAllocation={massAllocations[idx]}
        />
      ))}
    </RigidBody>
  );
}

function RiggedSimReadyVehicleInstance({
  item,
  paused,
  onAccessibilityChange,
}: {
  item: RiggedSimReadyVehicleItem;
  paused: boolean;
  onAccessibilityChange: () => void;
}) {
  const vehicleRef = useRef<EcctrlVehicleHandle>(null);
  const registerDynamicVehicle = useControlStore(
    (s) => s.registerDynamicVehicle
  );
  const unregisterDynamicVehicle = useControlStore(
    (s) => s.unregisterDynamicVehicle
  );
  const setNearbyDynamicVehicle = useControlStore(
    (s) => s.setNearbyDynamicVehicle
  );

  useEffect(() => {
    registerDynamicVehicle({
      id: item.id,
      label: item.label,
      mode: item.mode,
      getHandle: () => vehicleRef.current,
    });
    return () => {
      unregisterDynamicVehicle(item.id);
    };
  }, [item.id, item.label, item.mode, registerDynamicVehicle, unregisterDynamicVehicle]);

  // Stamp riggedId onto the underlying Rapier body userData once mounted so Mode 5 can remove it
  useEffect(() => {
    const body = vehicleRef.current?.body;
    if (!body) return;
    const prev = (body.userData as Record<string, unknown>) ?? {};
    const prevSim = (prev.simReady as Record<string, unknown>) ?? {};
    body.userData = {
      ...prev,
      simReady: {
        ...prevSim,
        isRiggedVehicle: true,
        riggedId: item.id,
        name: item.label,
        semantics: item.desc.semantics,
      },
    };
  });

  const sensorRadius = useMemo(() => {
    const { bounds } = computeSimReadyBounds(item.desc, 1);
    return Math.max(1.4, Math.max(bounds.halfExtents[0], bounds.halfExtents[2]) + 0.85);
  }, [item.desc]);

  return (
    <SimReadyVehicleRig
      ref={vehicleRef}
      rigidBodyDesc={item.desc}
      mode={item.mode}
      paused={paused}
      enableCustomGravity
      position={item.position}
      rotation={item.rotation}
    >
      <BallCollider
        sensor
        args={[sensorRadius]}
        mass={0}
        onIntersectionEnter={(e) => {
          if (e.colliderObject?.name === "character-capsule-collider") {
            setNearbyDynamicVehicle(item.id);
            onAccessibilityChange();
          }
        }}
        onIntersectionExit={(e) => {
          if (e.colliderObject?.name === "character-capsule-collider") {
            if (useControlStore.getState().nearbyDynamicVehicleId === item.id) {
              setNearbyDynamicVehicle(null);
            }
            onAccessibilityChange();
          }
        }}
      />
    </SimReadyVehicleRig>
  );
}

export interface SimReadyToolGunProps {
  ecctrlRef: React.RefObject<EcctrlHandle | null>;
  cameraControlsRef: React.RefObject<EcctrlCameraControlsHandle | null>;
  paused?: boolean;
  onVehicleAccessibilityChange: () => void;
}

export function SimReadyToolGun({
  ecctrlRef,
  cameraControlsRef,
  paused = false,
  onVehicleAccessibilityChange,
}: SimReadyToolGunProps) {
  const { rapier, world } = useRapier();
  const { camera, gl } = useThree();

  const bayAsset = useSimReadyUSD("/simready/warehouse_bay.usdz");
  const podAsset = useSimReadyUSD("/simready/sensor_pod.usdc");

  const spawnedProps = useToolGunStore((s) => s.spawnedProps);
  const riggedVehicles = useToolGunStore((s) => s.riggedVehicles);
  const clearWeldsSignal = useToolGunStore((s) => s.clearWeldsSignal);

  // Mouse NDC for unlocked third-person cursor aiming
  const mouseNdcRef = useRef(new THREE.Vector2(0, 0));
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const rotatingHeldRef = useRef(false);

  // Physgun grab state
  const grabStateRef = useRef<{
    bodyHandle: number;
    localPoint: THREE.Vector3;
    distance: number;
    targetQuat: THREE.Quaternion;
  } | null>(null);

  // Pending Weld Shot 1 + active welds
  const pendingWeldRef = useRef<PendingWeldAnchor | null>(null);
  const activeWeldsRef = useRef<ActiveWeldRecord[]>([]);

  // Transient laser pulse visual (for discrete shots: Spawn / Weld / Rig / Remove)
  const shotPulseRef = useRef<{
    from: THREE.Vector3;
    to: THREE.Vector3;
    color: THREE.Color;
    ttl: number;
  } | null>(null);

  // Visual beam & gizmo refs (updated imperatively in useFrame — zero React re-renders)
  const beamLineRef = useRef<THREE.Line>(null);
  const beamHitOrbRef = useRef<THREE.Mesh>(null);
  const pendingWeldOrbRef = useRef<THREE.Mesh>(null);
  const weldLinesRef = useRef<THREE.LineSegments>(null);

  const beamGeometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(24 * 3);
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geom;
  }, []);

  const beamMaterial = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: "#38bdf8",
        transparent: true,
        opacity: 0.95,
      }),
    []
  );

  const beamLineObject = useMemo(
    () => new THREE.Line(beamGeometry, beamMaterial),
    [beamGeometry, beamMaterial]
  );

  const weldGeometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(128 * 3);
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);
    return geom;
  }, []);

  // Register pointer-lock helper & external WebMCP weld hook
  useEffect(() => {
    useToolGunStore.getState().setRequestPointerLockFn(() => {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      } else {
        cameraControlsRef.current?.lockPointer();
      }
    });
    useToolGunStore.getState().setRegisterExternalWeldFn((w) => {
      activeWeldsRef.current.push({
        id: `weld_${nextEntityCounter++}`,
        joint: w.joint as ImpulseJoint,
        body0Handle: w.body0Handle,
        body1Handle: w.body1Handle,
        localAnchor0: new THREE.Vector3(...w.localAnchor0),
        localAnchor1: new THREE.Vector3(...w.localAnchor1),
        color: w.color ?? "#34d399",
      });
    });
    return () => {
      useToolGunStore.getState().setRequestPointerLockFn(null);
      useToolGunStore.getState().setRegisterExternalWeldFn(null);
    };
  }, [cameraControlsRef]);

  useEffect(() => {
    const onLockChange = () => {
      const locked = Boolean(document.pointerLockElement);
      useToolGunStore.getState().setPointerLocked(locked);
      if (locked) {
        mouseNdcRef.current.set(0, 0);
      }
    };
    document.addEventListener("pointerlockchange", onLockChange);
    return () => document.removeEventListener("pointerlockchange", onLockChange);
  }, []);

  // Clear all welds when clearWeldsSignal increments
  useEffect(() => {
    if (clearWeldsSignal === 0) return;
    for (const w of activeWeldsRef.current) {
      try {
        world.removeImpulseJoint(w.joint, true);
      } catch {
        // Ignore already-removed joint
      }
    }
    activeWeldsRef.current = [];
    pendingWeldRef.current = null;
  }, [clearWeldsSignal, world]);

  // Cleanup joints on unmount
  useEffect(() => {
    return () => {
      for (const w of activeWeldsRef.current) {
        try {
          world.removeImpulseJoint(w.joint, true);
        } catch {
          // Ignore
        }
      }
      activeWeldsRef.current = [];
    };
  }, [world]);

  const getGunMuzzlePos = useCallback((out: THREE.Vector3): THREE.Vector3 => {
    const activeCtrl = useControlStore.getState().activeController;
    if (activeCtrl === "ecctrl" && ecctrlRef.current?.body) {
      out
        .copy(ecctrlRef.current.currPos)
        .addScaledVector(ecctrlRef.current.bodyYAxis, 0.35)
        .addScaledVector(ecctrlRef.current.bodyXAxis, 0.32);
      return out;
    }
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const camUp = new THREE.Vector3(0, -1, 0).applyQuaternion(camera.quaternion);
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    out
      .copy(camera.position)
      .addScaledVector(camRight, 0.35)
      .addScaledVector(camUp, 0.25)
      .addScaledVector(camFwd, 0.6);
    return out;
  }, [camera, ecctrlRef]);

  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const castAimRay = useCallback(() => {
    const ndc = document.pointerLockElement
      ? new THREE.Vector2(0, 0)
      : mouseNdcRef.current;
    raycaster.setFromCamera(ndc, camera);
    const origin = raycaster.ray.origin;
    const dir = raycaster.ray.direction;

    const rapierRay = new rapier.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z }
    );

    const excludeBody =
      useControlStore.getState().activeController === "ecctrl"
        ? ecctrlRef.current?.body
        : undefined;

    const hit = world.castRayAndGetNormal(
      rapierRay,
      90,
      true,
      QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      excludeBody
    );

    if (!hit) {
      return {
        origin: origin.clone(),
        dir: dir.clone(),
        hit: null as null,
      };
    }

    const hitPoint = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(
      dir,
      hit.timeOfImpact
    );
    const hitNormal = new THREE.Vector3(
      hit.normal.x,
      hit.normal.y,
      hit.normal.z
    ).normalize();
    const hitBody = hit.collider.parent();

    return {
      origin: origin.clone(),
      dir: dir.clone(),
      hit: {
        toi: hit.timeOfImpact,
        point: hitPoint,
        normal: hitNormal,
        collider: hit.collider,
        body: hitBody,
      },
    };
  }, [camera, ecctrlRef, rapier, raycaster, world]);

  const triggerPulse = useCallback((to: THREE.Vector3, hexColor: string) => {
    const from = getGunMuzzlePos(new THREE.Vector3());
    shotPulseRef.current = {
      from,
      to: to.clone(),
      color: new THREE.Color(hexColor),
      ttl: 0.16,
    };
  }, [getGunMuzzlePos]);

  const resolveSpawnerTemplate = useCallback((): {
    label: string;
    desc: SimReadyRigidBodyDesc;
  } | null => {
    const { spawnerPreset, customAsset } = useToolGunStore.getState();

    if (spawnerPreset === "custom" && customAsset) {
      const customRb = customAsset.asset.physics.rigidBodies[0];
      if (customRb) {
        return { label: customAsset.filename.replace(/\.[^.]+$/, ""), desc: customRb };
      }
      return {
        label: customAsset.filename.replace(/\.[^.]+$/, ""),
        desc: {
          id: `/Custom/${customAsset.filename}`,
          name: customAsset.filename,
          primPath: "/",
          bodyType: "dynamic",
          position: [0, 0, 0],
          quaternion: [0, 0, 0, 1],
          mass: 20,
          colliders: customAsset.asset.physics.staticColliders,
          visualGroup: customAsset.asset.physics.staticVisualGroup,
          apiSchemas: ["PhysicsRigidBodyAPI"],
        },
      };
    }

    if (spawnerPreset === "sensor_pod") {
      const rb = podAsset.physics.rigidBodies[0];
      if (rb) return { label: "SensorPod (.usdc)", desc: rb };
    }

    const pathMap: Record<string, { path: string; label: string }> = {
      pallet: { path: "/World/Pallet_01", label: "EuroPallet" },
      crate: { path: "/World/Crate_01", label: "StorageCrate" },
      drum: { path: "/World/HazardDrum_01", label: "HazardDrum" },
    };
    const chosen = pathMap[spawnerPreset] ?? pathMap.pallet;
    const found = bayAsset.physics.rigidBodies.find(
      (b) => b.primPath === chosen.path
    );
    if (!found) return null;
    return { label: chosen.label, desc: found };
  }, [bayAsset, podAsset]);

  // Start Physgun Grab
  const startPhysgunGrab = useCallback(() => {
    const aim = castAimRay();
    if (!aim.hit || !aim.hit.body) return false;
    const body = aim.hit.body;
    const simMeta = (body.userData as { simReady?: SimReadyBodyUserData } | undefined)
      ?.simReady;

    // Allow grabbing dynamic bodies OR bodies previously frozen by the Physgun
    if (!body.isDynamic() && !simMeta?.physgunFrozen) {
      return false;
    }

    if (simMeta?.physgunFrozen) {
      simMeta.physgunFrozen = false;
      body.setBodyType(rapier.RigidBodyType.Dynamic, true);
    }

    body.wakeUp();
    const bodyPos = body.translation();
    const bodyRot = body.rotation();
    const invQ = new THREE.Quaternion(
      bodyRot.x,
      bodyRot.y,
      bodyRot.z,
      bodyRot.w
    ).invert();

    const localPoint = aim.hit.point
      .clone()
      .sub(new THREE.Vector3(bodyPos.x, bodyPos.y, bodyPos.z))
      .applyQuaternion(invQ);

    grabStateRef.current = {
      bodyHandle: body.handle,
      localPoint,
      distance: THREE.MathUtils.clamp(aim.hit.toi, 1.8, 35),
      targetQuat: new THREE.Quaternion(
        bodyRot.x,
        bodyRot.y,
        bodyRot.z,
        bodyRot.w
      ),
    };
    useToolGunStore.getState().setGrabbing(true);
    return true;
  }, [castAimRay, rapier]);

  const stopPhysgunGrab = useCallback(() => {
    if (!grabStateRef.current) return;
    grabStateRef.current = null;
    useToolGunStore.getState().setGrabbing(false);
  }, []);

  // Freeze / Unfreeze body with Physgun Alt-Fire
  const togglePhysgunFreeze = useCallback(() => {
    const store = useToolGunStore.getState();
    let targetBody: RapierRigidBody | null = null;

    if (grabStateRef.current) {
      targetBody = world.getRigidBody(grabStateRef.current.bodyHandle) ?? null;
      stopPhysgunGrab();
    } else {
      const aim = castAimRay();
      targetBody = aim.hit?.body ?? null;
    }

    if (!targetBody) return;
    const userData = ((targetBody.userData as Record<string, unknown>) ?? {});
    const simMeta: SimReadyBodyUserData =
      (userData.simReady as SimReadyBodyUserData) ?? {};

    if (targetBody.isDynamic()) {
      targetBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      targetBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      targetBody.setBodyType(rapier.RigidBodyType.Fixed, true);
      simMeta.physgunFrozen = true;
      userData.simReady = simMeta;
      targetBody.userData = userData;
      const t = targetBody.translation();
      triggerPulse(new THREE.Vector3(t.x, t.y, t.z), "#22d3ee");
      store.showToast(`Froze ${simMeta.name ?? "RigidBody"} in mid-air`);
    } else if (simMeta.physgunFrozen) {
      simMeta.physgunFrozen = false;
      userData.simReady = simMeta;
      targetBody.userData = userData;
      targetBody.setBodyType(rapier.RigidBodyType.Dynamic, true);
      targetBody.wakeUp();
      const t = targetBody.translation();
      triggerPulse(new THREE.Vector3(t.x, t.y, t.z), "#38bdf8");
      store.showToast(`Unfroze ${simMeta.name ?? "RigidBody"}`);
    }
  }, [castAimRay, rapier, stopPhysgunGrab, triggerPulse, world]);

  // Execute discrete Tool Gun shot for Modes 2, 3, 4, 5
  const fireDiscreteToolShot = useCallback(() => {
    const store = useToolGunStore.getState();
    const mode = store.mode;
    const aim = castAimRay();

    // MODE 2: SPAWN SIMREADY USD PROP
    if (mode === "spawner") {
      const tpl = resolveSpawnerTemplate();
      if (!tpl) return;
      const spawnPoint = aim.hit
        ? aim.hit.point.clone().addScaledVector(aim.hit.normal, 0.55)
        : aim.origin.clone().addScaledVector(aim.dir, 6);

      const id = `usdprop_${nextEntityCounter++}`;
      store.addSpawnedProp({
        id,
        label: tpl.label,
        desc: tpl.desc,
        position: [spawnPoint.x, spawnPoint.y, spawnPoint.z],
        quaternion: tpl.desc.quaternion,
      });
      triggerPulse(spawnPoint, "#4ade80");
      const qTag = tpl.desc.semantics?.wikidataQCode
        ? ` [${tpl.desc.semantics.wikidataQCode}]`
        : "";
      store.showToast(`Spawned SimReady ${tpl.label}${qTag}`);
      return;
    }

    if (!aim.hit || !aim.hit.body) return;
    const hitBody = aim.hit.body;
    const simMeta = (hitBody.userData as { simReady?: SimReadyBodyUserData } | undefined)
      ?.simReady;

    // MODE 3: WELD / HINGE JOINT GUN
    if (mode === "weld") {
      const bPos = hitBody.translation();
      const bRot = hitBody.rotation();
      const bQuat = new THREE.Quaternion(bRot.x, bRot.y, bRot.z, bRot.w);
      const invBQuat = bQuat.clone().invert();

      const localAnchor = aim.hit.point
        .clone()
        .sub(new THREE.Vector3(bPos.x, bPos.y, bPos.z))
        .applyQuaternion(invBQuat);
      const localNormal = aim.hit.normal
        .clone()
        .applyQuaternion(invBQuat)
        .normalize();
      const bodyLabel =
        simMeta?.name || (hitBody.isFixed() ? "World Surface" : "RigidBody");

      if (!pendingWeldRef.current) {
        pendingWeldRef.current = {
          bodyHandle: hitBody.handle,
          localAnchor,
          localNormal,
          worldPoint: aim.hit.point.clone(),
          label: bodyLabel,
        };
        store.setPendingWeldLabel(bodyLabel);
        triggerPulse(aim.hit.point, "#facc15");
        store.showToast(`Anchor 1 set on ${bodyLabel} — shoot 2nd object to weld`);
        return;
      }

      const first = pendingWeldRef.current;
      pendingWeldRef.current = null;
      store.setPendingWeldLabel(null);

      if (first.bodyHandle === hitBody.handle) {
        store.showToast("Cancelled weld (same body)");
        return;
      }

      const body0 = world.getRigidBody(first.bodyHandle);
      const body1 = hitBody;
      if (!body0 || (!body0.isDynamic() && !body1.isDynamic())) {
        store.showToast("At least one welded object must be dynamic");
        return;
      }

      const b0Rot = body0.rotation();
      const q0 = new THREE.Quaternion(b0Rot.x, b0Rot.y, b0Rot.z, b0Rot.w);
      const relFrame0 = { x: 0, y: 0, z: 0, w: 1 };
      const relQ = bQuat.clone().invert().multiply(q0).normalize();
      const relFrame1 = { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w };

      let joint: ImpulseJoint;
      const variant = store.weldVariant;

      if (variant === "fixed") {
        // Snap anchor0 and current relative offset or weld in-place cleanly:
        // Express body0's world anchor inside body1's frame if close, or weld at midpoint
        const worldA0 = first.localAnchor
          .clone()
          .applyQuaternion(q0)
          .add(
            new THREE.Vector3(
              body0.translation().x,
              body0.translation().y,
              body0.translation().z
            )
          );
        const inPlaceAnchor1 = worldA0
          .clone()
          .sub(new THREE.Vector3(bPos.x, bPos.y, bPos.z))
          .applyQuaternion(invBQuat);

        const data = rapier.JointData.fixed(
          { x: first.localAnchor.x, y: first.localAnchor.y, z: first.localAnchor.z },
          relFrame0,
          { x: inPlaceAnchor1.x, y: inPlaceAnchor1.y, z: inPlaceAnchor1.z },
          relFrame1
        );
        joint = world.createImpulseJoint(data, body0, body1, true);
      } else {
        // Revolute hinge around Shot 1's surface normal; snap dynamic body to hinge point!
        if (body0.isDynamic() && !body1.isDynamic()) {
          const targetWorld = aim.hit.point
            .clone()
            .sub(first.localAnchor.clone().applyQuaternion(q0));
          body0.setTranslation(
            { x: targetWorld.x, y: targetWorld.y, z: targetWorld.z },
            true
          );
        } else if (body1.isDynamic()) {
          const worldA0 = first.localAnchor
            .clone()
            .applyQuaternion(q0)
            .add(
              new THREE.Vector3(
                body0.translation().x,
                body0.translation().y,
                body0.translation().z
              )
            );
          const targetWorld = worldA0.sub(
            localAnchor.clone().applyQuaternion(bQuat)
          );
          body1.setTranslation(
            { x: targetWorld.x, y: targetWorld.y, z: targetWorld.z },
            true
          );
        }

        const axisWorld = first.localNormal.clone().applyQuaternion(q0).normalize();
        const axis1 = axisWorld.clone().applyQuaternion(invBQuat).normalize();
        const data = rapier.JointData.revolute(
          { x: first.localAnchor.x, y: first.localAnchor.y, z: first.localAnchor.z },
          { x: localAnchor.x, y: localAnchor.y, z: localAnchor.z },
          { x: first.localNormal.x, y: first.localNormal.y, z: first.localNormal.z }
        );
        // Keep axis2 aligned on body1
        data.axis = { x: axis1.x, y: axis1.y, z: axis1.z };
        joint = world.createImpulseJoint(data, body0, body1, true);
        joint.setContactsEnabled(false);

        if (variant === "motor_hinge") {
          const unit = joint as UnitImpulseJoint;
          unit.configureMotorModel(rapier.MotorModel.ForceBased);
          unit.configureMotorVelocity(5.0, 45);
        }
      }

      activeWeldsRef.current.push({
        id: `weld_${nextEntityCounter++}`,
        joint,
        body0Handle: body0.handle,
        body1Handle: body1.handle,
        localAnchor0: first.localAnchor.clone(),
        localAnchor1: localAnchor.clone(),
        color: variant === "fixed" ? "#facc15" : "#fb923c",
      });

      triggerPulse(aim.hit.point, "#facc15");
      store.showToast(
        variant === "fixed"
          ? `Welded ${first.label} ↔ ${bodyLabel}`
          : variant === "motor_hinge"
            ? `Motorized Axle ${first.label} ↔ ${bodyLabel}`
            : `Hinged ${first.label} ↔ ${bodyLabel}`
      );
      return;
    }

    // MODE 4 (#5!): RIG SIMREADY PROP INTO DRIVABLE ECCTRL VEHICLE (CAR OR DRONE)
    if (mode === "rig") {
      const rigMode = store.rigVariant;
      let targetDesc: SimReadyRigidBodyDesc | undefined = simMeta?.desc;
      let spawnPos: [number, number, number];
      let yaw = 0;

      const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      yaw = Math.atan2(camFwd.x, camFwd.z);

      if (targetDesc && !simMeta?.isRiggedVehicle) {
        const t = hitBody.translation();
        const r = hitBody.rotation();
        const liveQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(liveQuat);
        if (fwd.x * fwd.x + fwd.z * fwd.z > 0.05) {
          yaw = Math.atan2(fwd.x, fwd.z);
        }

        // Cleanly remove any welds attached to this prop before upgrading it
        activeWeldsRef.current = activeWeldsRef.current.filter((w) => {
          if (w.body0Handle === hitBody.handle || w.body1Handle === hitBody.handle) {
            try {
              world.removeImpulseJoint(w.joint, true);
            } catch {
              // Ignore
            }
            return false;
          }
          return true;
        });

        const { bounds } = computeSimReadyBounds(targetDesc, 1);
        const liftY =
          rigMode === "car"
            ? bounds.halfExtents[1] + 0.42
            : bounds.halfExtents[1] + 0.85;
        spawnPos = [t.x, t.y + liftY, t.z];

        simMeta?.retireBody?.();
      } else {
        // Hit ground/static mesh -> spawn a fresh SimReady USD vehicle right on the spot!
        const fallbackDesc =
          rigMode === "drone"
            ? podAsset.physics.rigidBodies[0]
            : bayAsset.physics.rigidBodies.find(
                (b) => b.primPath === "/World/Pallet_01"
              );
        if (!fallbackDesc) return;
        targetDesc = fallbackDesc;
        const { bounds } = computeSimReadyBounds(targetDesc, 1);
        const liftY =
          rigMode === "car"
            ? bounds.halfExtents[1] + 0.48
            : bounds.halfExtents[1] + 1.1;
        spawnPos = [
          aim.hit.point.x,
          aim.hit.point.y + liftY,
          aim.hit.point.z,
        ];
      }

      const vehId = `simveh:${nextEntityCounter++}` as const;
      const baseName = simMeta?.name ?? targetDesc.name;
      const label = `${baseName} ${rigMode === "car" ? "Buggy" : "Drone"}`;

      store.addRiggedVehicle({
        id: vehId,
        label,
        mode: rigMode,
        desc: targetDesc,
        position: spawnPos,
        rotation: [0, yaw, 0],
      });

      triggerPulse(aim.hit.point, "#a855f7");
      store.showToast(`Rigged ${label}! Walk up & press [F] to drive`);
      return;
    }

    // MODE 5: UNWELD / DISSOLVE REMOVER
    if (mode === "remove") {
      let removedWelds = 0;
      activeWeldsRef.current = activeWeldsRef.current.filter((w) => {
        if (w.body0Handle === hitBody.handle || w.body1Handle === hitBody.handle) {
          try {
            world.removeImpulseJoint(w.joint, true);
          } catch {
            // Ignore
          }
          removedWelds++;
          return false;
        }
        return true;
      });

      if (removedWelds > 0) {
        triggerPulse(aim.hit.point, "#f43f5e");
        store.showToast(
          `Snapped ${removedWelds} weld${removedWelds > 1 ? "s" : ""}`
        );
        return;
      }

      if (simMeta?.isRiggedVehicle && simMeta.riggedId) {
        store.removeRiggedVehicle(simMeta.riggedId);
        triggerPulse(aim.hit.point, "#f43f5e");
        store.showToast(`Removed ${simMeta.name ?? "SimReady Vehicle"}`);
        return;
      }

      if (simMeta?.isSpawnedProp && simMeta.spawnId) {
        store.removeSpawnedProp(simMeta.spawnId);
        triggerPulse(aim.hit.point, "#f43f5e");
        store.showToast(`Dissolved ${simMeta.name ?? "USD Prop"}`);
        return;
      }

      if (simMeta?.physgunFrozen) {
        simMeta.physgunFrozen = false;
        hitBody.setBodyType(rapier.RigidBodyType.Dynamic, true);
        hitBody.wakeUp();
        triggerPulse(aim.hit.point, "#f43f5e");
        store.showToast(`Unfroze ${simMeta.name ?? "RigidBody"}`);
      }
    }
  }, [
    bayAsset,
    camera,
    castAimRay,
    podAsset,
    rapier,
    resolveSpawnerTemplate,
    triggerPulse,
    world,
  ]);

  // Keyboard & mouse listeners
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable
      );
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const store = useToolGunStore.getState();

      if (e.code === "Digit1") store.setMode("physgun");
      else if (e.code === "Digit2") store.setMode("spawner");
      else if (e.code === "Digit3") store.setMode("weld");
      else if (e.code === "Digit4") store.setMode("rig");
      else if (e.code === "Digit5") store.setMode("remove");
      else if (e.code === "Tab") {
        e.preventDefault();
        store.requestPointerLockFn?.();
      } else if (e.code === "KeyR") {
        rotatingHeldRef.current = true;
      } else if (e.code === "BracketRight" && grabStateRef.current) {
        grabStateRef.current.distance = Math.min(
          35,
          grabStateRef.current.distance + 0.9
        );
      } else if (e.code === "BracketLeft" && grabStateRef.current) {
        grabStateRef.current.distance = Math.max(
          1.6,
          grabStateRef.current.distance - 0.9
        );
      } else if (e.code === "KeyQ" && !e.repeat) {
        if (store.mode === "physgun") {
          togglePhysgunFreeze();
        } else {
          store.cycleSubVariant();
        }
      } else if (e.code === "KeyE" && !e.repeat) {
        if (store.mode === "physgun") {
          startPhysgunGrab();
        } else {
          fireDiscreteToolShot();
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "KeyE") {
        stopPhysgunGrab();
      } else if (e.code === "KeyR") {
        rotatingHeldRef.current = false;
      }
    };

    const dom = gl.domElement;

    const onPointerMove = (e: PointerEvent) => {
      if (document.pointerLockElement) return;
      const rect = dom.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      mouseNdcRef.current.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      const store = useToolGunStore.getState();
      if (document.pointerLockElement) {
        if (e.button === 0) {
          if (store.mode === "physgun") startPhysgunGrab();
          else fireDiscreteToolShot();
        } else if (e.button === 2) {
          if (store.mode === "physgun") togglePhysgunFreeze();
          else store.cycleSubVariant();
        }
        return;
      }

      if (e.button === 0) {
        pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const store = useToolGunStore.getState();
      if (document.pointerLockElement) {
        if (e.button === 0) stopPhysgunGrab();
        return;
      }

      if (e.button === 0 && pointerDownPosRef.current) {
        const dx = e.clientX - pointerDownPosRef.current.x;
        const dy = e.clientY - pointerDownPosRef.current.y;
        pointerDownPosRef.current = null;
        // Quick click (< 5px movement, not an orbit drag) fires discrete Tool Gun modes!
        if (dx * dx + dy * dy < 25 && store.mode !== "physgun") {
          const rect = dom.getBoundingClientRect();
          mouseNdcRef.current.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          );
          fireDiscreteToolShot();
        }
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!grabStateRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      grabStateRef.current.distance = THREE.MathUtils.clamp(
        grabStateRef.current.distance - Math.sign(e.deltaY) * 0.85,
        1.6,
        35
      );
    };

    const onContextMenu = (e: MouseEvent) => {
      if (document.pointerLockElement) e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("wheel", onWheel, { passive: false, capture: true });
    dom.addEventListener("contextmenu", onContextMenu);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      dom.removeEventListener("contextmenu", onContextMenu);
    };
  }, [
    fireDiscreteToolShot,
    gl.domElement,
    startPhysgunGrab,
    stopPhysgunGrab,
    togglePhysgunFreeze,
  ]);

  // Per-frame Physgun PD Spring Beam + Target Scanner + Weld Line Visualization
  const muzzleVec = useMemo(() => new THREE.Vector3(), []);
  const curveCtrlVec = useMemo(() => new THREE.Vector3(), []);
  const curveObj = useMemo(
    () =>
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3()
      ),
    []
  );

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);

    // 1. Update live target scanner readout
    if (!grabStateRef.current) {
      const aim = castAimRay();
      if (aim.hit?.body) {
        const b = aim.hit.body;
        const simMeta = (b.userData as { simReady?: SimReadyBodyUserData } | undefined)
          ?.simReady;
        if (b.isDynamic() || simMeta && !simMeta.staticEnvironment) {
          const mass = b.isDynamic() ? Number(b.mass().toFixed(1)) : undefined;
          useToolGunStore.getState().setTarget({
            key: `${b.handle}`,
            name: simMeta?.name || "Dynamic Prop",
            primPath: simMeta?.primPath,
            qCode: simMeta?.semantics?.wikidataQCode,
            mass,
            frozen: Boolean(simMeta?.physgunFrozen),
            isRiggedVehicle: Boolean(simMeta?.isRiggedVehicle),
            distance: Number(aim.hit.toi.toFixed(1)),
          });
        } else {
          useToolGunStore.getState().setTarget(null);
        }
      } else {
        useToolGunStore.getState().setTarget(null);
      }
    }

    // 2. Step Physgun spring-damper beam if holding a body
    const grab = grabStateRef.current;
    let beamActive = false;

    if (grab && !paused) {
      const body = world.getRigidBody(grab.bodyHandle);
      if (!body || !body.isDynamic()) {
        stopPhysgunGrab();
      } else {
        body.wakeUp();
        const ndc = document.pointerLockElement
          ? new THREE.Vector2(0, 0)
          : mouseNdcRef.current;
        raycaster.setFromCamera(ndc, camera);

        const desiredWorldPoint = raycaster.ray.origin
          .clone()
          .addScaledVector(raycaster.ray.direction, grab.distance);

        const bPos = body.translation();
        const bRot = body.rotation();
        const bQuat = new THREE.Quaternion(bRot.x, bRot.y, bRot.z, bRot.w);

        if (rotatingHeldRef.current) {
          const spinQ = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            dt * 2.4
          );
          grab.targetQuat.premultiply(spinQ).normalize();
        }

        const currentGrabWorld = grab.localPoint
          .clone()
          .applyQuaternion(bQuat)
          .add(new THREE.Vector3(bPos.x, bPos.y, bPos.z));

        const mass = Math.max(1, body.mass());
        const linVel = body.linvel();
        const angVel = body.angvel();

        // Critically-damped PD velocity target clamped to safe max throw speed
        const posErr = desiredWorldPoint.clone().sub(currentGrabWorld);
        const desiredVel = posErr.multiplyScalar(14).clampLength(0, 28);
        const velDelta = desiredVel.sub(
          new THREE.Vector3(linVel.x, linVel.y, linVel.z)
        );
        const impulse = velDelta.multiplyScalar(mass * Math.min(1, dt * 22));
        body.applyImpulse(
          { x: impulse.x, y: impulse.y, z: impulse.z },
          true
        );

        // Smooth orientation lock + angular damping so held SimReady props don't spin wildly
        const qErr = grab.targetQuat.clone().multiply(bQuat.clone().invert());
        if (qErr.w < 0) {
          qErr.x = -qErr.x;
          qErr.y = -qErr.y;
          qErr.z = -qErr.z;
          qErr.w = -qErr.w;
        }
        const rotTargetAngVel = new THREE.Vector3(qErr.x, qErr.y, qErr.z).multiplyScalar(12);
        const nextAngVel = new THREE.Vector3(angVel.x, angVel.y, angVel.z).lerp(
          rotTargetAngVel,
          Math.min(1, dt * 15)
        );
        body.setAngvel(
          { x: nextAngVel.x, y: nextAngVel.y, z: nextAngVel.z },
          true
        );

        // Update curved GMod Physgun energy beam
        getGunMuzzlePos(muzzleVec);
        const midTangent = raycaster.ray.origin
          .clone()
          .addScaledVector(raycaster.ray.direction, grab.distance * 0.55);
        curveCtrlVec.copy(muzzleVec).lerp(midTangent, 0.65);

        curveObj.v0.copy(muzzleVec);
        curveObj.v1.copy(curveCtrlVec);
        curveObj.v2.copy(currentGrabWorld);

        const posAttr = beamGeometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < 24; i++) {
          const t = i / 23;
          const pt = curveObj.getPoint(t);
          posAttr.setXYZ(i, pt.x, pt.y, pt.z);
        }
        posAttr.needsUpdate = true;
        beamMaterial.color.set("#38bdf8");
        beamMaterial.opacity = 0.95;

        if (beamHitOrbRef.current) {
          beamHitOrbRef.current.visible = true;
          beamHitOrbRef.current.position.copy(currentGrabWorld);
          (beamHitOrbRef.current.material as THREE.MeshBasicMaterial).color.set(
            "#38bdf8"
          );
        }
        beamActive = true;
      }
    }

    // 3. Discrete shot laser pulse fallback when not holding Physgun
    if (!beamActive && shotPulseRef.current) {
      shotPulseRef.current.ttl -= dt;
      if (shotPulseRef.current.ttl <= 0) {
        shotPulseRef.current = null;
      } else {
        const pulse = shotPulseRef.current;
        const posAttr = beamGeometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < 24; i++) {
          const t = i / 23;
          posAttr.setXYZ(
            i,
            THREE.MathUtils.lerp(pulse.from.x, pulse.to.x, t),
            THREE.MathUtils.lerp(pulse.from.y, pulse.to.y, t),
            THREE.MathUtils.lerp(pulse.from.z, pulse.to.z, t)
          );
        }
        posAttr.needsUpdate = true;
        beamMaterial.color.copy(pulse.color);
        beamMaterial.opacity = pulse.ttl / 0.16;
        if (beamHitOrbRef.current) {
          beamHitOrbRef.current.visible = true;
          beamHitOrbRef.current.position.copy(pulse.to);
          (beamHitOrbRef.current.material as THREE.MeshBasicMaterial).color.copy(
            pulse.color
          );
        }
        beamActive = true;
      }
    }

    if (beamLineRef.current) beamLineRef.current.visible = beamActive;
    if (!beamActive && beamHitOrbRef.current) {
      beamHitOrbRef.current.visible = false;
    }

    // 4. Update Pending Weld Shot 1 Orb
    if (pendingWeldOrbRef.current) {
      const pw = pendingWeldRef.current;
      const b0 = pw ? world.getRigidBody(pw.bodyHandle) : null;
      if (pw && b0) {
        const t = b0.translation();
        const r = b0.rotation();
        const wPt = pw.localAnchor
          .clone()
          .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
          .add(new THREE.Vector3(t.x, t.y, t.z));
        pendingWeldOrbRef.current.visible = true;
        pendingWeldOrbRef.current.position.copy(wPt);
      } else {
        pendingWeldOrbRef.current.visible = false;
      }
    }

    // 5. Update Active Weld / Hinge Tether Lines
    if (weldLinesRef.current) {
      const posAttr = weldGeometry.attributes.position as THREE.BufferAttribute;
      let vertIdx = 0;
      activeWeldsRef.current = activeWeldsRef.current.filter((w) => {
        const b0 = world.getRigidBody(w.body0Handle);
        const b1 = world.getRigidBody(w.body1Handle);
        if (!b0 || !b1) return false;
        if (vertIdx + 2 <= 128) {
          const t0 = b0.translation();
          const r0 = b0.rotation();
          const p0 = w.localAnchor0
            .clone()
            .applyQuaternion(new THREE.Quaternion(r0.x, r0.y, r0.z, r0.w))
            .add(new THREE.Vector3(t0.x, t0.y, t0.z));

          const t1 = b1.translation();
          const r1 = b1.rotation();
          const p1 = w.localAnchor1
            .clone()
            .applyQuaternion(new THREE.Quaternion(r1.x, r1.y, r1.z, r1.w))
            .add(new THREE.Vector3(t1.x, t1.y, t1.z));

          posAttr.setXYZ(vertIdx++, p0.x, p0.y, p0.z);
          posAttr.setXYZ(vertIdx++, p1.x, p1.y, p1.z);
        }
        return true;
      });
      posAttr.needsUpdate = true;
      weldGeometry.setDrawRange(0, vertIdx);
      weldLinesRef.current.visible = vertIdx > 0;
    }
  });

  return (
    <group name="SimReadyToolGunGroup">
      {/* Physgun / Shot Energy Beam */}
      <primitive ref={beamLineRef} object={beamLineObject} frustumCulled={false} visible={false} />
      <mesh ref={beamHitOrbRef} visible={false} frustumCulled={false}>
        <sphereGeometry args={[0.11, 14, 14]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.9} />
      </mesh>

      {/* Pending Weld Anchor 1 Gizmo */}
      <mesh ref={pendingWeldOrbRef} visible={false} frustumCulled={false}>
        <sphereGeometry args={[0.1, 12, 12]} />
        <meshBasicMaterial color="#facc15" />
      </mesh>

      {/* Active Weld / Hinge Constraint Links */}
      <lineSegments
        ref={weldLinesRef}
        geometry={weldGeometry}
        frustumCulled={false}
        visible={false}
      >
        <lineBasicMaterial color="#facc15" transparent opacity={0.85} />
      </lineSegments>

      {/* Tool-Gun Spawned SimReady USD Props */}
      {spawnedProps.map((item) => (
        <SpawnedSimReadyPropInstance
          key={item.id}
          item={item}
          paused={paused}
        />
      ))}

      {/* Tool-Gun Rigged SimReady Vehicles (#5 Live Cars & Drones!) */}
      {riggedVehicles.map((item) => (
        <RiggedSimReadyVehicleInstance
          key={item.id}
          item={item}
          paused={paused}
          onAccessibilityChange={onVehicleAccessibilityChange}
        />
      ))}
    </group>
  );
}
