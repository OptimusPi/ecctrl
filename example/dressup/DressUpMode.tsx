import { Suspense, useEffect, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars, useGLTF } from "@react-three/drei";
import { useControls, button } from "leva";
import * as THREE from "three";
import { Wiggle } from "./Wiggle";

const CHARACTER_URL = "/models/fermme.glb";
const COSTUME_URL = "/models/jester.glb";

/**
 * SECRET MODE — the Planet-67 dress-up game, ported from /dressup.
 * Unlocked by typing "pifreak loves you!" anywhere in the game.
 * Own fullscreen Canvas overlaid on the running world; Escape returns you.
 */

/** Her — the rigged Tripo character. frustumCulled=false so bind-pose bounds don't cull her. */
function CharacterMesh() {
  const { scene } = useGLTF(CHARACTER_URL);
  useEffect(() => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        m.castShadow = true;
      }
    });
  }, [scene]);
  return <primitive object={scene} />;
}

/** The jester costume — loose meshes, clipped on by eye with leva sliders. */
function Costume() {
  const { scene } = useGLTF(COSTUME_URL);
  useEffect(() => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
  }, [scene]);
  const c = useControls("secret · costume (clip it on)", {
    posX: { value: 0, min: -2, max: 2, step: 0.001 },
    posY: { value: 0, min: -2, max: 2, step: 0.001 },
    posZ: { value: 0, min: -2, max: 2, step: 0.001 },
    rotX: { value: 0, min: -Math.PI, max: Math.PI, step: 0.01 },
    rotY: { value: Math.PI / 2, min: -Math.PI, max: Math.PI, step: 0.01 },
    rotZ: { value: 0, min: -Math.PI, max: Math.PI, step: 0.01 },
    scale: { value: 1, min: 0.05, max: 5, step: 0.001 },
    "log costume transform": button(() =>
      console.log("costume transform", {
        position: [c.posX, c.posY, c.posZ],
        rotation: [c.rotX, c.rotY, c.rotZ],
        scale: c.scale,
      })
    ),
  });
  return (
    <group
      position={[c.posX, c.posY, c.posZ]}
      rotation={[c.rotX, c.rotY, c.rotZ]}
      scale={c.scale}
    >
      <primitive object={scene} />
    </group>
  );
}

/** Her + costume in one group so dressing and resizing never drift apart. */
function Her() {
  const { charScale, charY } = useControls("secret · character", {
    charScale: { value: 1, min: 0.1, max: 5, step: 0.01 },
    charY: { value: 0, min: -2, max: 2, step: 0.01 },
  });
  return (
    <group scale={charScale} position={[0, charY, 0]}>
      <CharacterMesh />
      {/* Spring-bone secondary motion on HER skeleton (returns null, drives bones). */}
      <Wiggle />
      <Costume />
    </group>
  );
}

/** Stars pinned to the camera — infinite backdrop, no parallax swim. */
function Starfield() {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    ref.current?.position.copy(camera.position);
  });
  return (
    <group ref={ref}>
      <Stars radius={80} depth={40} count={2000} factor={4} fade speed={0} />
    </group>
  );
}

/** A little world for her to stand on. Top of the sphere sits at y=0 (her feet). */
function Planet() {
  const { radius, color } = useControls("secret · planet", {
    radius: { value: 3, min: 1, max: 25, step: 0.1 },
    color: "#5b6b8c",
  });
  return (
    <mesh position={[0, -radius, 0]} receiveShadow>
      <sphereGeometry args={[radius, 96, 96]} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>
  );
}

export function DressUpMode() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "#0e0e2a",
      }}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [0, 1, 3], fov: 50 }}
        style={{ background: "#0e0e2a" }}
      >
        <color attach="background" args={["#0e0e2a"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 10, 5]} intensity={1.6} castShadow />
        <directionalLight position={[-5, 3, -5]} intensity={0.4} />
        <Starfield />
        <Suspense fallback={null}>
          <Planet />
          <Her />
        </Suspense>
        <OrbitControls target={[0, 0.8, 0]} enableDamping />
      </Canvas>
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "#ff2975",
          fontFamily: "monospace",
          fontSize: 14,
          textShadow: "0 0 8px #ff297588",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        ♥ secret dress-up · she loves you too, pifreak · [Esc] returns to Planet-67 ♥
        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>mode installed by waterbear 🐻‍❄️</div>
      </div>
    </div>
  );
}

useGLTF.preload(CHARACTER_URL);
useGLTF.preload(COSTUME_URL);
