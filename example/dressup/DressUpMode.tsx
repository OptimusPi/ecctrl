import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars, useGLTF } from "@react-three/drei";
import { Physics } from "@react-three/rapier";
import { useControls } from "leva";
import * as THREE from "three";
import { Wiggle } from "./Wiggle";
import { AutoWiggle } from "./AutoWiggle";
import { Wardrobe } from "./Wardrobe";
import { PoseBones } from "./PoseBones";
import { GigglebonGun } from "./GigglebonGun";
import { Ragdoll } from "./Ragdoll";
import { WaterbearCritter } from "./WaterbearCritter";
import { useDroppedGlb } from "./useDroppedGlb";

const CHARACTER_URL = "/models/fermme.glb";
const COSTUME_URL = "/models/jester.glb";

/**
 * SECRET MODE — the Planet-67 dress-up game.
 * Unlocked by typing "pifreak loves you!" anywhere in the game. Esc returns.
 *
 * Pose her bones, drag wardrobe pieces onto her (double-click snaps them home),
 * drop any .glb to audition a new body (AutoWiggle guesses its jiggle), flip
 * "0 · chaos" to let gravity take her, and change the planet seed to derive a
 * whole new moon — same seed, same moon, every time. A tiny waterbear trundles
 * the surface through all of it.
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

/** A dropped stranger: normalized to girl-height, feet on the ground, jiggle guessed. */
function DroppedModel({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const { fit } = useMemo(() => {
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        m.castShadow = true;
      }
    });
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = size.y > 0 ? 1 / size.y : 1; // normalize to 1 unit tall, like her
    return { fit: { scale, y: -box.min.y * scale } };
  }, [scene]);
  return (
    <group scale={fit.scale} position={[0, fit.y, 0]}>
      <primitive object={scene} />
      <AutoWiggle object={scene} />
    </group>
  );
}

/** Her + the wardrobe in one group — or the dropped stranger, same wardrobe. */
function Pedestal({ droppedUrl }: { droppedUrl: string | null }) {
  const { charScale, charY } = useControls("secret · character", {
    charScale: { value: 1, min: 0.1, max: 5, step: 0.01 },
    charY: { value: 0, min: -2, max: 2, step: 0.01 },
  });
  return (
    <group scale={charScale} position={[0, charY, 0]}>
      <group name="dressup-body">
        <GigglebonGun>
          {droppedUrl ? <DroppedModel url={droppedUrl} /> : <CharacterMesh />}
        </GigglebonGun>
      </group>
      {/* Tripo-tuned springs for her; the dropped path carries its own AutoWiggle. */}
      {!droppedUrl && <Wiggle />}
      {/* Turn her bones — arms down out of the T-pose, so the clothes have a body to sit on. */}
      <PoseBones url={droppedUrl ?? CHARACTER_URL} />
      <Wardrobe />
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

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Dusty moon regolith, derived from the seed — smooth on the eyes on purpose:
 * soft radial gradients instead of hard circles, values kept in a narrow band,
 * fine grain instead of contrast. Same seed, same moon, every time.
 */
function usePlanetTexture(baseColor: string, seed: string) {
  return useMemo(() => {
    const size = 1024;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    let s = hashString(seed) || 1;
    const rand = () => {
      s = Math.imul(s ^ (s >>> 15), s | 1);
      s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
      return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    };

    g.fillStyle = baseColor;
    g.fillRect(0, 0, size, size);

    // Maria: broad, soft tonal fields. Gradients fade to nothing — zero hard edges.
    for (let i = 0; i < 70; i++) {
      const x = rand() * size, y = rand() * size, r = 60 + rand() * 180;
      const light = rand() > 0.5;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, light ? "rgba(255,255,255,0.045)" : "rgba(20,22,30,0.055)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Craters: a soft dark bowl and a whisper of a rim, both gradients.
    for (let i = 0; i < 42; i++) {
      const x = rand() * size, y = rand() * size, r = 6 + rand() * 26;
      const bowl = g.createRadialGradient(x, y, 0, x, y, r);
      bowl.addColorStop(0, "rgba(15,17,25,0.10)");
      bowl.addColorStop(0.75, "rgba(15,17,25,0.05)");
      bowl.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = bowl;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      const rim = g.createRadialGradient(x, y, r * 0.8, x, y, r * 1.15);
      rim.addColorStop(0, "rgba(0,0,0,0)");
      rim.addColorStop(0.6, "rgba(255,255,255,0.05)");
      rim.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = rim;
      g.fillRect(x - r * 1.2, y - r * 1.2, r * 2.4, r * 2.4);
    }

    // Regolith grain: thousands of near-invisible specks. Texture, not noise.
    for (let i = 0; i < 6000; i++) {
      const light = rand() > 0.5;
      g.fillStyle = light ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.035)";
      g.fillRect(rand() * size, rand() * size, 1.2, 1.2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [baseColor, seed]);
}

/** A little world for her to stand on. Top of the sphere sits at y=0 (her feet). */
function Planet({ radius, color, seed }: { radius: number; color: string; seed: string }) {
  const texture = usePlanetTexture(color, seed);
  return (
    <mesh position={[0, -radius, 0]} receiveShadow>
      <sphereGeometry args={[radius, 96, 96]} />
      <meshStandardMaterial map={texture} bumpMap={texture} bumpScale={0.6} roughness={1} />
    </mesh>
  );
}

export function DressUpMode() {
  const { url: droppedUrl, fileName, dragging } = useDroppedGlb();

  // The planet is derivable, like everything worth keeping: 8-ish characters in,
  // a whole moon out. Motely rules apply in the dress-up dimension too.
  const { radius, color, seed } = useControls("secret · planet", {
    radius: { value: 3, min: 1, max: 25, step: 0.1 },
    color: "#9aa0a8",
    seed: { value: "PIFREAK6", label: "planet seed" },
  });

  // 💀🦴 flip it and gravity takes her — every bone, all at once.
  const { ragdoll } = useControls("0 · chaos", { ragdoll: false });

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
        <Physics paused={!ragdoll} gravity={[0, -9.81, 0]}>
          <Suspense fallback={null}>
            <Planet radius={radius} color={color} seed={seed} />
            {ragdoll ? <Ragdoll planetRadius={radius} /> : <Pedestal droppedUrl={droppedUrl} />}
            <WaterbearCritter radius={radius} seed={seed} />
          </Suspense>
        </Physics>
        <OrbitControls makeDefault target={[0, 0.8, 0]} enableDamping />
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
        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>
          mode installed by waterbear 🐻‍❄️ · grab a piece + drag it to her · double-click a piece = it snaps on
          <br />
          drop a .glb to audition a new body{fileName ? ` · now fitting: ${fileName}` : ""} · only glitchbots that lose bets end up here
        </div>
      </div>
      {dragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#ff297522",
            border: "3px dashed #ff2975",
            color: "#fff",
            fontFamily: "monospace",
            fontSize: 24,
            pointerEvents: "none",
          }}
        >
          drop the .glb — the pedestal is ready
        </div>
      )}
    </div>
  );
}

useGLTF.preload(CHARACTER_URL);
useGLTF.preload(COSTUME_URL);
