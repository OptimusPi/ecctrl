import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * A tiny waterbear trundling around the planet, forever. Survives vacuum,
 * radiation, ragdoll mode, and rm -rf. Box-built, N64 quality, on purpose.
 * The seed decides his path and his pace — same seed, same bear, every time.
 */

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function WaterbearCritter({ radius, seed }: { radius: number; seed: string }) {
  const group = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Mesh | null)[]>([]);

  const { polar, speed, phase } = useMemo(() => {
    const r = hashString(seed);
    return {
      polar: 0.7 + r * 0.6, // how far down from the top of the planet he walks
      speed: 0.06 + r * 0.06, // rad/s — tardigrade pace
      phase: r * Math.PI * 2,
    };
  }, [seed]);

  const dir = useRef(new THREE.Vector3());
  const fwd = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const basis = useRef(new THREE.Matrix4());

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    const lon = phase + t * speed;
    // Position on the sphere (planet center is at [0, -radius, 0], top at y=0).
    dir.current.set(
      Math.sin(polar) * Math.cos(lon),
      Math.cos(polar),
      Math.sin(polar) * Math.sin(lon)
    );
    g.position.copy(dir.current).multiplyScalar(radius + 0.02).add(new THREE.Vector3(0, -radius, 0));
    // Stand on the surface: up = radial; walk along longitude.
    fwd.current.set(-Math.sin(lon), 0, Math.cos(lon)).projectOnPlane(dir.current).normalize();
    right.current.crossVectors(dir.current, fwd.current);
    basis.current.makeBasis(right.current, dir.current, fwd.current);
    g.quaternion.setFromRotationMatrix(basis.current);
    // Stubby legs paddle.
    legs.current.forEach((leg, i) => {
      if (leg) leg.rotation.x = Math.sin(t * 9 + i * 1.3) * 0.5;
    });
  });

  const bodyMat = <meshStandardMaterial color="#c9d6de" flatShading />;
  return (
    <group ref={group} scale={0.6}>
      {/* three chubby segments */}
      <mesh castShadow position={[0, 0.09, 0.07]}><sphereGeometry args={[0.075, 10, 8]} />{bodyMat}</mesh>
      <mesh castShadow position={[0, 0.1, 0]}><sphereGeometry args={[0.085, 10, 8]} />{bodyMat}</mesh>
      <mesh castShadow position={[0, 0.09, -0.08]}><sphereGeometry args={[0.07, 10, 8]} />{bodyMat}</mesh>
      {/* snoot */}
      <mesh castShadow position={[0, 0.08, 0.135]}><sphereGeometry args={[0.035, 8, 6]} />{bodyMat}</mesh>
      {/* eight stubby legs */}
      {[0, 1, 2, 3].map((row) =>
        [-1, 1].map((side) => (
          <mesh
            key={`${row}${side}`}
            ref={(m) => { legs.current[row * 2 + (side + 1) / 2] = m; }}
            castShadow
            position={[side * 0.07, 0.045, 0.09 - row * 0.055]}
            rotation={[0, 0, side * 0.5]}
          >
            <cylinderGeometry args={[0.012, 0.016, 0.06, 6]} />
            {bodyMat}
          </mesh>
        ))
      )}
    </group>
  );
}
