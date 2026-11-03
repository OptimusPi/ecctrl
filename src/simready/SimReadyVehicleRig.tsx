/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import * as THREE from "three";
import React, { forwardRef, useMemo } from "react";
import { CuboidCollider } from "@react-three/rapier";
import type { ForwardRefComponent } from "../shared/types";
import EcctrlVehicle, {
  type CarConfigType,
  type DroneConfigType,
  type EcctrlVehicleHandle,
} from "../vehicles/EcctrlVehicle";
import ShapeCastWheel from "../vehicles/components/ShapeCastWheel";
import ThrustPropeller from "../vehicles/components/ThrustPropeller";
import { useSimReadyUSD } from "./SimReadyUSDLoader";
import {
  buildColliderMassAllocations,
  SimReadyColliderItem,
} from "./SimReadyStage";
import type {
  SimReadyBounds,
  SimReadyColliderDesc,
  SimReadyRigidBodyDesc,
  SimReadyUSDAsset,
  SimReadyVehicleRigProps,
} from "./types";

/**
 * Computes Y-up oriented chassis transform, centered local bounding box, and physical mass
 * for any `SimReadyRigidBodyDesc` so it aligns cleanly with `EcctrlVehicle` (+Y up, +Z forward).
 */
export function computeSimReadyBounds(
  desc: SimReadyRigidBodyDesc,
  scale = 1
): {
  bounds: SimReadyBounds;
  bakeQuaternion: THREE.Quaternion;
  centerOffset: THREE.Vector3;
} {
  // Base orientation from the USD prim's composed stage quaternion (converts Z-up prims to Y-up)
  const baseQuat = new THREE.Quaternion(
    desc.quaternion[0],
    desc.quaternion[1],
    desc.quaternion[2],
    desc.quaternion[3]
  ).normalize();

  // Measure initial Y-up bounding box
  const measureGroup = new THREE.Group();
  const inner = desc.visualGroup.clone(true);
  inner.scale.setScalar(scale);
  measureGroup.quaternion.copy(baseQuat);
  measureGroup.add(inner);
  measureGroup.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(measureGroup);
  if (box.isEmpty()) {
    box.set(
      new THREE.Vector3(-0.5 * scale, -0.2 * scale, -0.5 * scale),
      new THREE.Vector3(0.5 * scale, 0.2 * scale, 0.5 * scale)
    );
  }

  const initialSize = new THREE.Vector3();
  box.getSize(initialSize);

  // Orient the longer horizontal dimension along +Z (vehicle wheelbase forward)
  const bakeQuaternion = baseQuat.clone();
  if (initialSize.x > initialSize.z * 1.15) {
    const yaw90 = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2
    );
    bakeQuaternion.premultiply(yaw90);
    measureGroup.quaternion.copy(bakeQuaternion);
    measureGroup.updateMatrixWorld(true);
    box.setFromObject(measureGroup);
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  size.x = Math.max(0.25, size.x);
  size.y = Math.max(0.12, size.y);
  size.z = Math.max(0.25, size.z);

  const volume = size.x * size.y * size.z;
  const rawMass =
    desc.mass !== undefined && desc.mass > 0
      ? desc.mass * Math.pow(scale, 3)
      : Math.max(15, volume * 60);
  const estimatedMass = Math.max(18, rawMass);

  return {
    bounds: {
      min: [box.min.x - center.x, box.min.y - center.y, box.min.z - center.z],
      max: [box.max.x - center.x, box.max.y - center.y, box.max.z - center.z],
      size: [size.x, size.y, size.z],
      center: [center.x, center.y, center.z],
      halfExtents: [size.x * 0.5, size.y * 0.5, size.z * 0.5],
      estimatedMass,
    },
    bakeQuaternion,
    centerOffset: center,
  };
}

function DefaultWheelMesh({ radius, width }: { radius: number; width: number }) {
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, width, 20]} />
        <meshStandardMaterial color="#1e293b" roughness={0.75} metalness={0.15} />
      </mesh>
      <mesh>
        <cylinderGeometry args={[radius * 0.52, radius * 0.52, width * 1.04, 12]} />
        <meshStandardMaterial color="#38bdf8" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

function DefaultPropellerMesh({ radius }: { radius: number }) {
  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[radius * 2, 0.025, radius * 0.22]} />
        <meshStandardMaterial color="#38bdf8" roughness={0.25} metalness={0.6} />
      </mesh>
      <mesh castShadow rotation={[0, Math.PI / 2, 0]}>
        <boxGeometry args={[radius * 2, 0.025, radius * 0.22]} />
        <meshStandardMaterial color="#38bdf8" roughness={0.25} metalness={0.6} />
      </mesh>
    </group>
  );
}

const SimReadyVehicleRigResolved = forwardRef<
  EcctrlVehicleHandle,
  Omit<SimReadyVehicleRigProps, "url" | "asset"> & { desc: SimReadyRigidBodyDesc }
>(
  (
    {
      desc,
      mode = "car",
      scale = 1,
      paused = false,
      wheelModel,
      propellerModel,
      carConfig,
      droneConfig,
      enableCustomGravity = true,
      enable = true,
      children,
      ...vehicleProps
    },
    ref
  ) => {
    const { bounds, bakeQuaternion, centerOffset } = useMemo(
      () => computeSimReadyBounds(desc, scale),
      [desc, scale]
    );

    const visualClone = useMemo(() => {
      const clone = desc.visualGroup.clone(true);
      clone.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });
      return clone;
    }, [desc.visualGroup]);

    // Transform colliders into the centered Y-up EcctrlVehicle frame
    const transformedColliders = useMemo<SimReadyColliderDesc[]>(() => {
      return desc.colliders.map((c) => {
        const p = new THREE.Vector3(
          c.position[0] * scale,
          c.position[1] * scale,
          c.position[2] * scale
        )
          .applyQuaternion(bakeQuaternion)
          .sub(centerOffset);

        const q = new THREE.Quaternion(
          c.quaternion[0],
          c.quaternion[1],
          c.quaternion[2],
          c.quaternion[3]
        ).premultiply(bakeQuaternion);

        return {
          ...c,
          position: [p.x, p.y, p.z],
          quaternion: [q.x, q.y, q.z, q.w],
        };
      });
    }, [desc.colliders, scale, bakeQuaternion, centerOffset]);

    const normalizedDesc = useMemo<SimReadyRigidBodyDesc>(
      () => ({
        ...desc,
        mass: bounds.estimatedMass,
        centerOfMass: undefined,
        diagonalInertia: undefined,
        colliders: transformedColliders,
      }),
      [desc, bounds.estimatedMass, transformedColliders]
    );

    const massAllocations = useMemo(
      () => buildColliderMassAllocations(normalizedDesc, 1),
      [normalizedDesc]
    );

    const [hx, hy, hz] = bounds.halfExtents;
    const mass = bounds.estimatedMass;

    // Auto-sized 4-wheel layout & suspension tuned to actual SimReady PhysicsMassAPI mass
    const wheelRadius = THREE.MathUtils.clamp(
      Math.max(hx, hz) * 0.42,
      0.22,
      0.55
    );
    const wheelHalfWidth = THREE.MathUtils.clamp(wheelRadius * 0.32, 0.08, 0.18);
    const rayLength = Math.max(0.28, wheelRadius * 0.95);
    const wheelX = Math.max(0.42, hx + wheelHalfWidth * 0.85);
    const wheelY = -hy + wheelRadius * 0.35;
    const wheelZ = Math.max(0.45, hz * 0.72);

    const springK = Math.max(450, mass * 22);
    const dampingC = Math.max(55, mass * 2.7);
    const maxBrakeTorque = Math.max(90, mass * 1.9);
    const wheelDensity = THREE.MathUtils.clamp(mass * 0.08, 2, 100);

    const mergedCarConfig = useMemo<Partial<CarConfigType>>(
      () => ({
        engineHorsepower: Math.max(24, mass * 0.45),
        engineMaxRPM: 6000,
        finalDriveRatio: 1,
        maxSteerAngle: Math.PI / 5.5,
        reverseRPMScale: 0.45,
        ...carConfig,
      }),
      [mass, carConfig]
    );

    // Auto-sized 4-propeller quadcopter layout & PD gains tuned to SimReady mass
    const armX = Math.max(0.55, hx * 1.1);
    const armY = hy + 0.08;
    const armZ = Math.max(0.55, hz * 1.1);
    const rotorRadius = THREE.MathUtils.clamp(
      Math.min(armX, armZ) * 0.55,
      0.22,
      0.65
    );
    const maxThrustPerRotor = Math.max(120, mass * 6.5);

    const mergedDroneConfig = useMemo<Partial<DroneConfigType>>(
      () => ({
        controlMode: "VELOCITY",
        maxHorizSpeed: 22,
        maxVertSpeed: 9,
        maxYawRate: 2.2,
        TILT_P: Math.max(10, mass * 0.14),
        TILT_D: Math.max(2.2, mass * 0.028),
        YAW_VEL_P: Math.max(3.5, mass * 0.045),
        ...droneConfig,
      }),
      [mass, droneConfig]
    );

    const visualPos = useMemo<[number, number, number]>(
      () => [-centerOffset.x, -centerOffset.y, -centerOffset.z],
      [centerOffset]
    );

    const wheelProps = {
      enable: !paused && enable,
      rayShapeR: wheelRadius,
      rayShapeH: wheelHalfWidth,
      rayLength,
      springK,
      dampingC,
      maxBrakeTorque,
      tireGripFactor: 1.4,
      wheelModelRadius: wheelRadius,
      wheelModelDensity: wheelDensity,
      debug: false,
    };

    const propProps = {
      enable: !paused && enable,
      maxThrust: maxThrustPerRotor,
      torqueRatio: 0.6,
      debug: false,
    };

    return (
      <EcctrlVehicle
        ref={ref}
        enable={!paused && enable}
        enableCustomGravity={enableCustomGravity}
        carConfig={mergedCarConfig}
        droneConfig={mergedDroneConfig}
        userData={{
          simReady: {
            primPath: desc.primPath,
            name: desc.name,
            semantics: desc.semantics,
            isRiggedVehicle: true,
            rigMode: mode,
          },
        }}
        {...vehicleProps}
      >
        {/* Centered SimReady visual hierarchy */}
        <group position={visualPos}>
          <group quaternion={bakeQuaternion} scale={scale}>
            <primitive object={visualClone} />
          </group>
        </group>

        {/* SimReady UsdPhysics compound colliders (or fallback chassis box) */}
        {transformedColliders.length > 0 ? (
          transformedColliders.map((c, idx) => (
            <SimReadyColliderItem
              key={c.id}
              collider={c}
              scale={1}
              bodyMaterial={desc.material}
              massAllocation={massAllocations[idx]}
            />
          ))
        ) : (
          <CuboidCollider args={[hx, hy, hz]} mass={mass} />
        )}

        {mode === "car" ? (
          <>
            <ShapeCastWheel
              {...wheelProps}
              steerWheel
              driveWheel
              brakeWheel
              position={[wheelX, wheelY, wheelZ]}
            >
              {wheelModel ?? (
                <DefaultWheelMesh radius={wheelRadius} width={wheelHalfWidth * 2} />
              )}
            </ShapeCastWheel>
            <ShapeCastWheel
              {...wheelProps}
              steerWheel
              driveWheel
              brakeWheel
              position={[-wheelX, wheelY, wheelZ]}
            >
              {wheelModel ?? (
                <DefaultWheelMesh radius={wheelRadius} width={wheelHalfWidth * 2} />
              )}
            </ShapeCastWheel>
            <ShapeCastWheel
              {...wheelProps}
              driveWheel
              brakeWheel
              position={[wheelX, wheelY, -wheelZ]}
            >
              {wheelModel ?? (
                <DefaultWheelMesh radius={wheelRadius} width={wheelHalfWidth * 2} />
              )}
            </ShapeCastWheel>
            <ShapeCastWheel
              {...wheelProps}
              driveWheel
              brakeWheel
              position={[-wheelX, wheelY, -wheelZ]}
            >
              {wheelModel ?? (
                <DefaultWheelMesh radius={wheelRadius} width={wheelHalfWidth * 2} />
              )}
            </ShapeCastWheel>
          </>
        ) : (
          <>
            {/* Subtle rotor outrigger arms */}
            <mesh position={[0, armY - 0.03, 0]}>
              <boxGeometry args={[armX * 2, 0.03, 0.05]} />
              <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[0, armY - 0.03, 0]}>
              <boxGeometry args={[0.05, 0.03, armZ * 2]} />
              <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
            </mesh>

            <ThrustPropeller
              {...propProps}
              invertTorque
              position={[armX, armY, armZ]}
            >
              {propellerModel ?? <DefaultPropellerMesh radius={rotorRadius} />}
            </ThrustPropeller>
            <ThrustPropeller
              {...propProps}
              position={[-armX, armY, armZ]}
            >
              {propellerModel ?? <DefaultPropellerMesh radius={rotorRadius} />}
            </ThrustPropeller>
            <ThrustPropeller
              {...propProps}
              position={[armX, armY, -armZ]}
            >
              {propellerModel ?? <DefaultPropellerMesh radius={rotorRadius} />}
            </ThrustPropeller>
            <ThrustPropeller
              {...propProps}
              invertTorque
              position={[-armX, armY, -armZ]}
            >
              {propellerModel ?? <DefaultPropellerMesh radius={rotorRadius} />}
            </ThrustPropeller>
          </>
        )}

        {children}
      </EcctrlVehicle>
    );
  }
);

function pickRigidBodyDesc(
  asset: SimReadyUSDAsset,
  primPath?: string
): SimReadyRigidBodyDesc {
  if (primPath) {
    const found = asset.physics.rigidBodies.find((b) => b.primPath === primPath);
    if (found) return found;
  }
  if (asset.physics.rigidBodies.length > 0) {
    return asset.physics.rigidBodies[0];
  }
  // Synthesize a dynamic descriptor from static stage visuals/colliders if the USD had no PhysicsRigidBodyAPI
  return {
    id: asset.physics.staticColliders[0]?.id ?? "/StageChassis",
    name: "SimReadyChassis",
    primPath: "/",
    bodyType: "dynamic",
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    colliders: asset.physics.staticColliders,
    visualGroup: asset.physics.staticVisualGroup,
    apiSchemas: ["PhysicsRigidBodyAPI"],
  };
}

const SimReadyVehicleRigFromUrl = forwardRef<
  EcctrlVehicleHandle,
  Omit<SimReadyVehicleRigProps, "asset" | "rigidBodyDesc"> & { url: string }
>(({ url, primPath, ...rest }, ref) => {
  const asset = useSimReadyUSD(url);
  const desc = useMemo(() => pickRigidBodyDesc(asset, primPath), [asset, primPath]);
  return <SimReadyVehicleRigResolved ref={ref} desc={desc} {...rest} />;
});

/**
 * Auto-rigs any OpenUSD / SimReady asset or `SimReadyRigidBodyDesc` into a drivable `<EcctrlVehicle>`
 * with mass-scaled `ShapeCastWheel` suspension (`mode="car"`) or `ThrustPropeller` stabilization (`mode="drone"`).
 */
export const SimReadyVehicleRig: ForwardRefComponent<
  SimReadyVehicleRigProps,
  EcctrlVehicleHandle
> = /* @__PURE__ */ forwardRef<EcctrlVehicleHandle, SimReadyVehicleRigProps>(
  ({ rigidBodyDesc, asset, url, primPath, ...rest }, ref) => {
    if (rigidBodyDesc) {
      return (
        <SimReadyVehicleRigResolved ref={ref} desc={rigidBodyDesc} {...rest} />
      );
    }
    if (asset) {
      const desc = pickRigidBodyDesc(asset, primPath);
      return <SimReadyVehicleRigResolved ref={ref} desc={desc} {...rest} />;
    }
    if (url) {
      return (
        <SimReadyVehicleRigFromUrl
          ref={ref}
          url={url}
          primPath={primPath}
          {...rest}
        />
      );
    }
    throw new Error(
      "SimReadyVehicleRig requires `rigidBodyDesc`, `asset`, or `url`."
    );
  }
);
