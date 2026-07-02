import { useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { useControls } from "leva";
import * as THREE from "three";

/**
 * 🔫 THE GIGGLEBONE GUN — invented by pifreak, holstered by waterbear.
 *
 * Arm it in leva, click any skinned body, and a jiggle bone is INJECTED AT THE
 * IMPACT POINT: anchored to the nearest real bone (so it rides the pose), verts
 * around the hit re-skinned onto it, driven by the same verlet spring as every
 * other wobble on this planet. Each shot makes the world slightly more alive.
 * The gun does not run out of ammunition. That is the point of the gun.
 */

const MAX_BLEND = 0.8;
let shotCounter = 0;

type GunSpring = {
  bone: THREE.Bone;
  anchor: THREE.Object3D;
  restLocal: THREE.Vector3;
  maxDisp: number;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  phase: number;
  seeded: boolean;
};

function scaleOf(m: THREE.Matrix4) {
  return new THREE.Vector3().setFromMatrixColumn(m, 0).length() || 1;
}

export function GigglebonGun({ children }: { children: ReactNode }) {
  const springs = useRef<GunSpring[]>([]);

  const { armed, radius, stiffness, damping, idle } = useControls("🔫 gigglebone gun", {
    armed: { value: false, label: "ARM THE GUN" },
    radius: { value: 0.06, min: 0.01, max: 0.3, step: 0.005, label: "blast radius" },
    stiffness: { value: 14, min: 1, max: 30, step: 0.5 },
    damping: { value: 0.1, min: 0, max: 0.6, step: 0.01, label: "damping (low=bouncy)" },
    idle: { value: 0.7, min: 0, max: 3, step: 0.05, label: "idle life" },
  }, { collapsed: true });

  const fire = (e: any) => {
    if (!armed) return;
    const mesh = e.object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return; // the gun only blesses things with skeletons
    e.stopPropagation();

    const point = (e.point as THREE.Vector3).clone();
    mesh.updateWorldMatrix(true, false);
    const skel = mesh.skeleton;

    // Anchor: nearest REAL bone to the impact, so the new wobble rides the pose.
    let anchor: THREE.Bone | null = null;
    let best = Infinity;
    const bw = new THREE.Vector3();
    for (const b of skel.bones) {
      if (/^(Auto)?Jiggle_|^GunBone_/.test(b.name)) continue;
      b.getWorldPosition(bw);
      const d = bw.distanceToSquared(point);
      if (d < best) { best = d; anchor = b; }
    }
    if (!anchor) return;

    const worldR = radius * scaleOf(mesh.matrixWorld);

    // Born at the wound, parented to the nearest bone, identity at bind.
    const bone = new THREE.Bone();
    bone.name = `GunBone_${shotCounter++}`;
    bone.position.copy(anchor.worldToLocal(point.clone()));
    anchor.add(bone);
    bone.updateMatrixWorld(true);
    const inv = bone.matrixWorld.clone().invert();

    // Re-skin the blast radius onto the new bone.
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const idxAttr = geo.attributes.skinIndex as THREE.BufferAttribute;
    const wAttr = geo.attributes.skinWeight as THREE.BufferAttribute;
    const jointIndex = skel.bones.length;
    const vWorld = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      vWorld.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      const d = vWorld.distanceTo(point);
      if (d >= worldR) continue;
      const t = 1 - d / worldR;
      const f = t * t * (3 - 2 * t);
      const blend = f * MAX_BLEND;
      if (blend <= 0.001) continue;
      const ix = [idxAttr.getX(i), idxAttr.getY(i), idxAttr.getZ(i), idxAttr.getW(i)];
      const wt = [wAttr.getX(i), wAttr.getY(i), wAttr.getZ(i), wAttr.getW(i)];
      let s = 0;
      for (let k = 1; k < 4; k++) if (wt[k] < wt[s]) s = k;
      ix[s] = jointIndex;
      wt[s] = 0;
      for (let k = 0; k < 4; k++) wt[k] *= 1 - blend;
      wt[s] = blend;
      const sum = wt[0] + wt[1] + wt[2] + wt[3] || 1;
      idxAttr.setXYZW(i, ix[0], ix[1], ix[2], ix[3]);
      wAttr.setXYZW(i, wt[0] / sum, wt[1] / sum, wt[2] / sum, wt[3] / sum);
    }
    idxAttr.needsUpdate = true;
    wAttr.needsUpdate = true;
    mesh.bind(new THREE.Skeleton([...skel.bones, bone], [...skel.boneInverses, inv]), mesh.bindMatrix);

    springs.current.push({
      bone,
      anchor,
      restLocal: bone.position.clone(),
      maxDisp: radius * 0.6,
      pos: new THREE.Vector3(),
      prevPos: new THREE.Vector3().setY(0.03), // arrive with a little birth-kick
      phase: Math.random() * Math.PI * 2,
      seeded: false,
    });
  };

  // scratch
  const restWorld = useRef(new THREE.Vector3());
  const next = useRef(new THREE.Vector3());
  const inertia = useRef(new THREE.Vector3());
  const disp = useRef(new THREE.Vector3());

  useFrame((state, delta) => {
    const list = springs.current;
    if (!list.length) return;
    const dt = Math.min(delta, 1 / 30);
    const t = state.clock.elapsedTime;
    for (const s of list) {
      s.anchor.updateWorldMatrix(true, false);
      const scale = scaleOf(s.anchor.matrixWorld);
      restWorld.current.copy(s.restLocal).applyMatrix4(s.anchor.matrixWorld);
      if (!s.seeded) {
        s.pos.copy(restWorld.current);
        s.prevPos.copy(restWorld.current).y += 0.02;
        s.seeded = true;
      }
      inertia.current.copy(s.pos).sub(s.prevPos).multiplyScalar(1 - damping);
      next.current
        .copy(s.pos)
        .add(inertia.current)
        .addScaledVector(restWorld.current.clone().sub(s.pos), stiffness * dt);
      next.current.y += Math.sin(t * 6 + s.phase) * idle * 0.004 * scale;
      next.current.x += Math.cos(t * 4.3 + s.phase) * idle * 0.003 * scale;
      disp.current.copy(next.current).sub(restWorld.current);
      const max = s.maxDisp * scale;
      if (disp.current.length() > max) disp.current.setLength(max);
      next.current.copy(restWorld.current).add(disp.current);
      s.prevPos.copy(s.pos);
      s.pos.copy(next.current);
      s.bone.position.copy(s.anchor.worldToLocal(next.current.clone()));
      s.bone.updateMatrixWorld(true);
    }
  });

  return <group onPointerDown={fire}>{children}</group>;
}
