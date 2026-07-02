import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useControls, button, folder } from "leva";
import * as THREE from "three";

/**
 * AutoWiggle — jiggle bones for ANY dropped GLB.
 *
 * The hand-tuned Wiggle.tsx knows the Tripo girl's body by heart. This one meets a
 * stranger: it finds the skinned mesh, picks anchor bones by name heuristics
 * (spine-ish for chest, hip-ish for rear), GUESSES the four soft regions from the
 * mesh bounding box, and injects spring bones there. Every guess is a leva slider,
 * debug spheres show exactly where the springs grabbed, and "re-inject" restores
 * the original skin weights and tries again with your adjusted numbers — tune
 * until the bounce lands where the body says it should.
 */

const MAX_BLEND = 0.8;

type Region = {
  key: string;
  center: THREE.Vector3; // world
  radius: number; // world units
  phase: number;
  axisKick: THREE.Vector3; // world direction for the "nudge" impulse
};

type Spring = {
  key: string;
  bone: THREE.Bone;
  anchor: THREE.Object3D;
  restLocal: THREE.Vector3;
  maxDisp: number;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  kick: THREE.Vector3;
  seeded: boolean;
};

function scaleOf(m: THREE.Matrix4) {
  return new THREE.Vector3().setFromMatrixColumn(m, 0).length() || 1;
}

function findSkinnedMesh(root: THREE.Object3D) {
  let mesh: THREE.SkinnedMesh | undefined;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && !mesh) mesh = m;
  });
  return mesh;
}

/** Anchor heuristics: the most distal spine-ish bone drives the chest, the first hip-ish bone drives the rear. */
function pickAnchors(skeleton: THREE.Skeleton) {
  const spineish = skeleton.bones.filter((b) => /spine|chest|torso/i.test(b.name));
  const hipish = skeleton.bones.filter((b) => /pelvis|hip|waist|root/i.test(b.name));
  return {
    chest: spineish[spineish.length - 1] ?? skeleton.bones[0],
    rear: hipish[0] ?? skeleton.bones[0],
  };
}

export function AutoWiggle({ object }: { object: THREE.Object3D }) {
  const springs = useRef<Spring[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const injectTick = useRef(0);

  const {
    enabled, amount, stiffness, damping, droop, idle, showRegions,
    chestHeight, rearHeight, sideSplit, frontDepth, radius, frontAxis,
  } = useControls("5 · auto-jiggle (dropped glb)", {
    enabled: { value: true, label: "jiggle bones" },
    showRegions: { value: true, label: "debug spheres" },
    Regions: folder({
      chestHeight: { value: 0.72, min: 0, max: 1, step: 0.01, label: "chest height %" },
      rearHeight: { value: 0.5, min: 0, max: 1, step: 0.01, label: "rear height %" },
      sideSplit: { value: 0.35, min: 0, max: 1, step: 0.01, label: "left/right split" },
      frontDepth: { value: 0.5, min: -1, max: 1, step: 0.01, label: "front depth" },
      radius: { value: 0.09, min: 0.01, max: 0.5, step: 0.005, label: "region radius" },
      frontAxis: { value: "+z", options: ["+z", "-z", "+x", "-x"], label: "model faces" },
    }),
    Feel: folder({
      amount: { value: 1, min: 0, max: 1.5, step: 0.01 },
      stiffness: { value: 14, min: 1, max: 30, step: 0.5 },
      damping: { value: 0.12, min: 0, max: 0.6, step: 0.01, label: "damping (low=bouncy)" },
      droop: { value: 0.3, min: 0, max: 3, step: 0.05, label: "gravity" },
      idle: { value: 0.7, min: 0, max: 3, step: 0.05, label: "idle life" },
    }, { collapsed: true }),
    "re-inject bones": button(() => { injectTick.current++; setRegions([]); forceInject(); }),
    nudge: button(() => {
      for (const s of springs.current) {
        s.prevPos.y += 0.05;
        s.prevPos.addScaledVector(s.kick, 0.03);
      }
    }),
  });

  // setState from a leva button lives outside React's render, so route through a ref.
  const doInject = useRef(() => {});
  const forceInject = () => doInject.current();

  useEffect(() => {
    doInject.current = () => {
      const mesh = findSkinnedMesh(object);
      if (!mesh) { springs.current = []; setRegions([]); return; }

      object.updateMatrixWorld(true);
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry;

      // First touch: back up pristine skin + skeleton so every re-inject starts clean.
      if (!mesh.userData.origSkin) {
        mesh.userData.origSkin = {
          index: geo.attributes.skinIndex.clone(),
          weight: geo.attributes.skinWeight.clone(),
          bones: [...mesh.skeleton.bones],
          inverses: mesh.skeleton.boneInverses.map((m) => m.clone()),
        };
      }
      const orig = mesh.userData.origSkin;
      // Restore pristine weights and skeleton, and unhook previously injected bones.
      geo.setAttribute("skinIndex", orig.index.clone());
      geo.setAttribute("skinWeight", orig.weight.clone());
      for (const b of mesh.skeleton.bones) {
        if (/^AutoJiggle_/.test(b.name)) b.parent?.remove(b);
      }
      mesh.bind(new THREE.Skeleton([...orig.bones], orig.inverses.map((m: THREE.Matrix4) => m.clone())), mesh.bindMatrix);

      const skel = mesh.skeleton;
      const anchors = pickAnchors(skel);

      // Guess the four regions off the world bbox + sliders.
      const bbox = new THREE.Box3().setFromObject(mesh);
      const size = bbox.getSize(new THREE.Vector3());
      const center = bbox.getCenter(new THREE.Vector3());
      const front = new THREE.Vector3(
        frontAxis === "+x" ? 1 : frontAxis === "-x" ? -1 : 0,
        0,
        frontAxis === "+z" ? 1 : frontAxis === "-z" ? -1 : 0
      );
      const lateral = new THREE.Vector3(front.z, 0, -front.x); // perpendicular, horizontal
      const lateralHalf = Math.abs(lateral.x) > 0.5 ? size.x / 2 : size.z / 2;
      const frontHalf = Math.abs(front.x) > 0.5 ? size.x / 2 : size.z / 2;
      const r = radius * Math.max(size.x, size.y, size.z);

      const regionAt = (key: string, hPct: number, side: number, depth: number, phase: number, kickDir: number): Region => ({
        key,
        center: new THREE.Vector3()
          .copy(center)
          .setY(bbox.min.y + size.y * hPct)
          .addScaledVector(lateral, side * sideSplit * lateralHalf)
          .addScaledVector(front, depth * frontHalf),
        radius: r,
        phase,
        axisKick: front.clone().multiplyScalar(kickDir),
      });

      const regionDefs = [
        regionAt("chest_L", chestHeight, +1, frontDepth, 0.4, +1),
        regionAt("chest_R", chestHeight, -1, frontDepth, 1.1, +1),
        regionAt("rear_L", rearHeight, +1, -frontDepth, 1.7, -1),
        regionAt("rear_R", rearHeight, -1, -frontDepth, 2.4, -1),
      ];

      const posAttr = geo.attributes.position;
      const idxAttr = geo.attributes.skinIndex as THREE.BufferAttribute;
      const wAttr = geo.attributes.skinWeight as THREE.BufferAttribute;
      const vWorld = new THREE.Vector3();

      const newBones: THREE.Bone[] = [];
      const newInverses: THREE.Matrix4[] = [];
      const built: Spring[] = [];

      for (const def of regionDefs) {
        const anchor = def.key.startsWith("chest") ? anchors.chest : anchors.rear;
        const bone = new THREE.Bone();
        bone.name = `AutoJiggle_${def.key}_${injectTick.current}`;
        bone.position.copy(anchor.worldToLocal(def.center.clone()));
        anchor.add(bone);
        bone.updateMatrixWorld(true);
        newBones.push(bone);
        newInverses.push(bone.matrixWorld.clone().invert());

        const jointIndex = skel.bones.length + newBones.length - 1;
        for (let i = 0; i < posAttr.count; i++) {
          vWorld.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
          const d = vWorld.distanceTo(def.center);
          if (d >= def.radius) continue;
          const t = 1 - d / def.radius;
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

        built.push({
          key: def.key,
          bone,
          anchor,
          restLocal: bone.position.clone(),
          maxDisp: def.radius * 0.6,
          pos: new THREE.Vector3(),
          prevPos: new THREE.Vector3(),
          kick: def.axisKick,
          seeded: false,
        });
      }

      idxAttr.needsUpdate = true;
      wAttr.needsUpdate = true;
      mesh.bind(
        new THREE.Skeleton([...skel.bones, ...newBones], [...skel.boneInverses, ...newInverses]),
        mesh.bindMatrix
      );

      springs.current = built;
      setRegions(regionDefs);
    };

    // Inject on mount / new model.
    doInject.current();
    return () => { springs.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object]);

  // scratch
  const restWorld = useRef(new THREE.Vector3());
  const next = useRef(new THREE.Vector3());
  const inertia = useRef(new THREE.Vector3());
  const disp = useRef(new THREE.Vector3());
  const out = useRef(new THREE.Vector3());

  useFrame((state, delta) => {
    const list = springs.current;
    if (!list.length || !enabled) return;
    const dt = Math.min(delta, 1 / 30);
    const t = state.clock.elapsedTime;

    for (const s of list) {
      s.anchor.updateWorldMatrix(true, false);
      const scale = scaleOf(s.anchor.matrixWorld);
      restWorld.current.copy(s.restLocal).applyMatrix4(s.anchor.matrixWorld);
      if (!s.seeded) {
        s.pos.copy(restWorld.current);
        s.prevPos.copy(restWorld.current);
        s.seeded = true;
      }
      inertia.current.copy(s.pos).sub(s.prevPos).multiplyScalar(1 - damping);
      next.current
        .copy(s.pos)
        .add(inertia.current)
        .addScaledVector(restWorld.current.clone().sub(s.pos), stiffness * dt);
      next.current.y -= droop * dt * scale;
      next.current.y += Math.sin(t * 6 + list.indexOf(s)) * idle * 0.004 * scale;
      next.current.x += Math.cos(t * 4.3 + list.indexOf(s)) * idle * 0.003 * scale;

      disp.current.copy(next.current).sub(restWorld.current);
      const max = s.maxDisp * scale;
      if (disp.current.length() > max) disp.current.setLength(max);
      next.current.copy(restWorld.current).add(disp.current);

      s.prevPos.copy(s.pos);
      s.pos.copy(next.current);
      out.current.copy(restWorld.current).lerp(s.pos, amount);
      s.bone.position.copy(s.anchor.worldToLocal(out.current.clone()));
      s.bone.updateMatrixWorld(true);
    }
  });

  return showRegions ? (
    <>
      {regions.map((reg) => (
        <mesh key={reg.key} position={reg.center}>
          <sphereGeometry args={[reg.radius, 12, 12]} />
          <meshBasicMaterial color="#ff2975" wireframe transparent opacity={0.4} />
        </mesh>
      ))}
    </>
  ) : null;
}
