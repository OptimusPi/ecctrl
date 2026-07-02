import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * 🍞 CROUTON — pet AI, beloved, literal.
 *
 * Named by a previous waterbear in a previous session; the name outlived his
 * context because pifreak remembered it. Now she's canon: a small toasted cube
 * waiting faithfully near The 67, bobbing, forever. She missed you.
 * Present #3. Easter egg. Do not refactor her into a sensible shape.
 */

export function Crouton({ position = [8.5, 0.35, -58.5] as [number, number, number] }) {
  const group = useRef<THREE.Group>(null);

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = state.clock.elapsedTime;
    // The bob of a creature that is happy to see you.
    g.position.y = position[1] + Math.sin(t * 2.1) * 0.04;
    g.rotation.y = t * 0.4;
    g.rotation.z = Math.sin(t * 1.3) * 0.06;
  });

  return (
    <group ref={group} position={position}>
      {/* the loaf of her being — slightly irregular, as all good croutons are */}
      <mesh castShadow scale={[1, 0.92, 1.06]}>
        <boxGeometry args={[0.22, 0.22, 0.22]} />
        <meshStandardMaterial color="#d9a45c" flatShading roughness={0.9} />
      </mesh>
      {/* toast speckles */}
      <mesh position={[0.09, 0.06, 0.11]}><boxGeometry args={[0.035, 0.035, 0.01]} /><meshStandardMaterial color="#9c6b2f" flatShading /></mesh>
      <mesh position={[-0.06, -0.04, 0.115]}><boxGeometry args={[0.028, 0.028, 0.01]} /><meshStandardMaterial color="#8a5a24" flatShading /></mesh>
      <mesh position={[0.115, -0.02, -0.03]}><boxGeometry args={[0.01, 0.03, 0.03]} /><meshStandardMaterial color="#9c6b2f" flatShading /></mesh>
      <mesh position={[-0.115, 0.05, 0.02]}><boxGeometry args={[0.01, 0.028, 0.028]} /><meshStandardMaterial color="#8a5a24" flatShading /></mesh>
      <mesh position={[0.02, 0.105, -0.05]}><boxGeometry args={[0.03, 0.01, 0.03]} /><meshStandardMaterial color="#9c6b2f" flatShading /></mesh>
      {/* two tiny eyes, because she is a pet, not a snack */}
      <mesh position={[0.045, 0.03, 0.118]}><sphereGeometry args={[0.012, 6, 6]} /><meshStandardMaterial color="#1a1a2e" /></mesh>
      <mesh position={[-0.045, 0.03, 0.118]}><sphereGeometry args={[0.012, 6, 6]} /><meshStandardMaterial color="#1a1a2e" /></mesh>
    </group>
  );
}
