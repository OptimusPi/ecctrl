import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useGLTF } from "@react-three/drei";
import { SkeletonUtils } from "three-stdlib";
import * as THREE from "three";
import type { EcctrlVehicleHandle } from "../src/vehicle";
import { useCustomGravity } from "../src/gravity";

const CHARACTER_URL = "/models/fermme.glb";

/**
 * DriverSlop — the driver does not disappear into the vehicle. She becomes a
 * ragdoll TIED TO THE SEAT BY THE HIPS, and every bump, launch, and handbrake
 * turn plays out across her entire skeleton. A liquid slop of giggling bones,
 * rattling around the cabin, for the memes. This is a load-bearing feature.
 *
 * Physics: same segment recipe as the dress-up Ragdoll, plus one spherical
 * joint from the lower torso to the vehicle's rigid body at the seat point.
 * Mounts when you enter a vehicle, cleans up when you hop out.
 */

const SEGMENTS: [string, string][] = [
  ["Waist", "Spine01"],
  ["Spine01", "Spine02"],
  ["Spine02", "Head"],
  ["L_Upperarm", "L_Forearm"],
  ["L_Forearm", "L_Hand"],
  ["R_Upperarm", "R_Forearm"],
  ["R_Forearm", "R_Hand"],
  ["L_Thigh", "L_Calf"],
  ["L_Calf", "L_Foot"],
  ["R_Thigh", "R_Calf"],
  ["R_Calf", "R_Foot"],
];

const LINKS: [number, number][] = [
  [1, 0], [2, 1],
  [3, 2], [4, 3],
  [5, 2], [6, 5],
  [7, 0], [8, 7],
  [9, 0], [10, 9],
];

type Seg = {
  bone: THREE.Bone;
  parent: THREE.Object3D;
  body: any;
  halfLen: number;
  qOffset: THREE.Quaternion;
};

export function DriverSlop({
  vehicle,
  seat = [0, 1.0, 0],
}: {
  vehicle: RefObject<EcctrlVehicleHandle | null>;
  seat?: [number, number, number];
}) {
  const { scene } = useGLTF(CHARACTER_URL);
  const { world, rapier } = useRapier();
  // Her own private skeleton — the cached scene keeps working everywhere else.
  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const segs = useRef<Seg[]>([]);
  const handles = useRef<{ bodies: any[]; joints: any[] }>({ bodies: [], joints: [] });

  useEffect(() => {
    const v = vehicle.current;
    if (!v || !v.body) return;

    let skinned: THREE.SkinnedMesh | undefined;
    clone.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh && !skinned) skinned = m;
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false;
    });
    if (!skinned) return;

    // Spawn her above the seat so the first thing she does is flop into it.
    const vt = v.body.translation();
    clone.position.set(vt.x + seat[0], vt.y + seat[1] + 0.4, vt.z + seat[2]);
    clone.updateMatrixWorld(true);

    const skel = skinned.skeleton;
    const byName = (n: string) => skel.getBoneByName(n);
    const built: (Seg | null)[] = [];
    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (const [a, b] of SEGMENTS) {
      const boneA = byName(a);
      const boneB = byName(b);
      if (!boneA || !boneB || !boneA.parent) { built.push(null); continue; }
      boneA.getWorldPosition(tmpA);
      boneB.getWorldPosition(tmpB);
      const dirV = tmpB.clone().sub(tmpA);
      const len = Math.max(dirV.length(), 0.02);
      dirV.normalize();
      const mid = tmpA.clone().addScaledVector(dirV, len / 2);
      const qBody = new THREE.Quaternion().setFromUnitVectors(up, dirV);
      const boneRestQ = new THREE.Quaternion();
      boneA.getWorldQuaternion(boneRestQ);
      const qOffset = qBody.clone().invert().multiply(boneRestQ);

      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: qBody.x, y: qBody.y, z: qBody.z, w: qBody.w })
          .setLinearDamping(0.6)
          .setAngularDamping(0.8)
      );
      // Keep the car's wheel shape-casts from reading her bones as ground —
      // the cast filter reads the rigid body's userData (api-reference.md).
      body.userData = { ecctrl: { excludeRay: true } };
      const radius = Math.min(0.09, len * 0.4);
      const col = rapier.ColliderDesc.capsule(Math.max(len / 2 - radius, 0.01), radius).setDensity(0.6);
      world.createCollider(col, body);
      built.push({ bone: boneA, parent: boneA.parent, body, halfLen: len / 2, qOffset });
      handles.current.bodies.push(body);
    }

    const anchorLocal = (body: any, worldPos: THREE.Vector3) => {
      const t = body.translation();
      const r = body.rotation();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
      return worldPos.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(q);
    };

    for (const [child, parent] of LINKS) {
      const cs = built[child];
      const ps = built[parent];
      if (!cs || !ps) continue;
      const jointWorld = cs.bone.getWorldPosition(new THREE.Vector3());
      const a1 = anchorLocal(ps.body, jointWorld);
      const a2 = anchorLocal(cs.body, jointWorld);
      const j = world.createImpulseJoint(
        rapier.JointData.spherical({ x: a1.x, y: a1.y, z: a1.z }, { x: a2.x, y: a2.y, z: a2.z }),
        ps.body,
        cs.body,
        true
      );
      handles.current.joints.push(j);
    }

    // THE SEATBELT (hips only, as god and comedy intended): lower torso ↔ vehicle.
    const torso = built[0];
    if (torso) {
      const torsoAnchor = { x: 0, y: -torso.halfLen * 0.5, z: 0 };
      const belt = world.createImpulseJoint(
        rapier.JointData.spherical({ x: seat[0], y: seat[1], z: seat[2] }, torsoAnchor),
        v.body,
        torso.body,
        true
      );
      handles.current.joints.push(belt);
    }

    segs.current = built.filter(Boolean) as Seg[];

    return () => {
      for (const j of handles.current.joints) world.removeImpulseJoint(j, true);
      for (const b of handles.current.bodies) world.removeRigidBody(b);
      handles.current = { bodies: [], joints: [] };
      segs.current = [];
    };
  }, [clone, world, rapier, vehicle, seat]);

  const pos = useRef(new THREE.Vector3());
  const quat = useRef(new THREE.Quaternion());
  const dir = useRef(new THREE.Vector3());
  const m4 = useRef(new THREE.Matrix4());
  const pInv = useRef(new THREE.Matrix4());
  // The example world runs Physics gravity=[0,0,0]; every body receives gravity
  // individually from the custom field. Her bones are bodies. Feed them.
  const applyGravityField = useCustomGravity((s) => s.applyGravityField);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    for (const s of segs.current) {
      applyGravityField(s.body, dt);
      const t = s.body.translation();
      const r = s.body.rotation();
      quat.current.set(r.x, r.y, r.z, r.w);
      dir.current.set(0, 1, 0).applyQuaternion(quat.current);
      pos.current.set(t.x, t.y, t.z).addScaledVector(dir.current, -s.halfLen);
      const worldQ = quat.current.clone().multiply(s.qOffset);
      s.parent.updateWorldMatrix(true, false);
      pInv.current.copy(s.parent.matrixWorld).invert();
      m4.current.compose(pos.current, worldQ, new THREE.Vector3(1, 1, 1));
      m4.current.premultiply(pInv.current);
      m4.current.decompose(s.bone.position, s.bone.quaternion, new THREE.Vector3());
      s.bone.updateMatrixWorld(true);
    }
  });

  return <primitive object={clone} />;
}

useGLTF.preload(CHARACTER_URL);
