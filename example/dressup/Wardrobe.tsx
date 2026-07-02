import { useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";

const COSTUME_URL = "/models/jester.glb";

/**
 * The wardrobe — the jester costume exploded into its ~25 loose pieces, scattered
 * in a ring around the pedestal (glitchbots that lose bets leave their clothes here).
 *
 * Mechanic: GRAB a piece and drag it — it moves on a camera-facing plane, orbit
 * pauses while you hold it. DOUBLE-CLICK a piece and it snaps home onto her body,
 * exactly where the costume author fit it. Dress her piece by piece, or fling the
 * hat into orbit. Both are valid play.
 */

type Piece = {
  mesh: THREE.Mesh;
  home: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
};

export function Wardrobe() {
  const { scene } = useGLTF(COSTUME_URL);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;

  const pieces = useMemo<Piece[]>(() => {
    scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) meshes.push(m);
    });
    return meshes.map((mesh, i) => {
      mesh.castShadow = true;
      // Bake the assembled ("home") transform in wardrobe-local space. The whole
      // wardrobe group is rotated 90° so homes line up with her facing (see README).
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      mesh.matrixWorld.decompose(pos, quat, scl);
      const home = { position: pos.clone(), quaternion: quat.clone(), scale: scl.clone() };
      // Scatter start: a ring around the pedestal, staggered heights.
      const a = (i / meshes.length) * Math.PI * 2;
      mesh.position.set(Math.cos(a) * 1.6, 0.15 + (i % 5) * 0.18, Math.sin(a) * 1.6);
      mesh.quaternion.copy(quat);
      mesh.scale.copy(scl);
      return { mesh, home };
    });
  }, [scene]);

  // One active drag at a time: camera-facing plane through the grab point.
  const drag = useRef<{
    piece: Piece;
    plane: THREE.Plane;
    offset: THREE.Vector3;
  } | null>(null);
  const hit = useRef(new THREE.Vector3());

  const onDown = (piece: Piece) => (e: any) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    if (controls) controls.enabled = false;
    const camDir = new THREE.Vector3();
    e.camera.getWorldDirection(camDir);
    const worldPos = piece.mesh.getWorldPosition(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, worldPos);
    const grab = e.ray.intersectPlane(plane, new THREE.Vector3()) ?? worldPos;
    drag.current = { piece, plane, offset: worldPos.clone().sub(grab) };
  };

  const onMove = (piece: Piece) => (e: any) => {
    const d = drag.current;
    if (!d || d.piece !== piece) return;
    e.stopPropagation();
    if (!e.ray.intersectPlane(d.plane, hit.current)) return;
    hit.current.add(d.offset);
    const parent = piece.mesh.parent;
    piece.mesh.position.copy(parent ? parent.worldToLocal(hit.current.clone()) : hit.current);
  };

  const onUp = (piece: Piece) => (e: any) => {
    if (drag.current?.piece === piece) {
      e.stopPropagation();
      drag.current = null;
      if (controls) controls.enabled = true;
    }
  };

  const snapHome = (piece: Piece) => (e: any) => {
    e.stopPropagation();
    piece.mesh.position.copy(piece.home.position);
    piece.mesh.quaternion.copy(piece.home.quaternion);
    piece.mesh.scale.copy(piece.home.scale);
  };

  return (
    <group rotation={[0, Math.PI / 2, 0]}>
      {pieces.map((piece) => (
        <primitive
          key={piece.mesh.uuid}
          object={piece.mesh}
          onPointerDown={onDown(piece)}
          onPointerMove={onMove(piece)}
          onPointerUp={onUp(piece)}
          onDoubleClick={snapHome(piece)}
        />
      ))}
    </group>
  );
}

useGLTF.preload(COSTUME_URL);
