import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useControls, button } from "leva";
import * as THREE from "three";

/**
 * PoseBones — pick any bone, turn it. The dropdown lists the whole skeleton
 * (arms first, they're what you reach for when dressing someone out of a T-pose);
 * sliders rotate the selected bone relative to its bind pose, offsets are
 * remembered per bone, and "reset pose" puts every bone back the way the
 * rigger left it. Drives the cached scene — works on her and on dropped models.
 */

const ARMISH = /arm|shoulder|clavicle|hand|elbow/i;

export function PoseBones({ url }: { url: string }) {
  const { scene } = useGLTF(url);

  const bones = useMemo(() => {
    const found: THREE.Bone[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone && !/^(Auto)?Jiggle_/i.test(o.name)) found.push(o as THREE.Bone);
    });
    // Arms float to the top of the menu; the rest keep skeleton order.
    return [...found.filter((b) => ARMISH.test(b.name)), ...found.filter((b) => !ARMISH.test(b.name))];
  }, [scene]);

  // Bind-pose quaternions + per-bone applied offsets, so switching bones keeps poses.
  const base = useRef(new Map<string, THREE.Quaternion>());
  const offsets = useRef(new Map<string, [number, number, number]>());
  useEffect(() => {
    base.current.clear();
    offsets.current.clear();
    for (const b of bones) base.current.set(b.name, b.quaternion.clone());
  }, [bones]);

  const names = bones.map((b) => b.name);
  const [{ bone: selected, rotX, rotY, rotZ }, set] = useControls(
    "6 · pose (turn her bones)",
    () => ({
      bone: { value: names[0] ?? "", options: names, label: "bone" },
      rotX: { value: 0, min: -Math.PI, max: Math.PI, step: 0.01 },
      rotY: { value: 0, min: -Math.PI, max: Math.PI, step: 0.01 },
      rotZ: { value: 0, min: -Math.PI, max: Math.PI, step: 0.01 },
      "reset pose": button(() => {
        for (const b of bones) {
          const q = base.current.get(b.name);
          if (q) b.quaternion.copy(q);
          b.updateMatrixWorld(true);
        }
        offsets.current.clear();
        set({ rotX: 0, rotY: 0, rotZ: 0 });
      }),
    }),
    { collapsed: true },
    [names.join("|")]
  );

  // Selecting a bone recalls the offset it already carries.
  const lastSelected = useRef(selected);
  useEffect(() => {
    if (lastSelected.current === selected) return;
    lastSelected.current = selected;
    const [x, y, z] = offsets.current.get(selected) ?? [0, 0, 0];
    set({ rotX: x, rotY: y, rotZ: z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Apply: bind pose × slider offset.
  useEffect(() => {
    const bone = bones.find((b) => b.name === selected);
    const bind = base.current.get(selected);
    if (!bone || !bind) return;
    offsets.current.set(selected, [rotX, rotY, rotZ]);
    const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ));
    bone.quaternion.copy(bind).multiply(offset);
    bone.updateMatrixWorld(true);
  }, [selected, rotX, rotY, rotZ, bones]);

  return null;
}
