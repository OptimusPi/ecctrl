import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useControls, button } from 'leva'
import * as THREE from 'three'

const CHARACTER_URL = '/models/fermme.glb'

/**
 * Real jiggle bones on HER body — not the clothes.
 *
 * The Tripo rig has no soft bones (no breast/glute/hair bones), so a humanoid
 * spine/pelvis can only ever *sway* the whole torso, never bounce locally. So we
 * BUILD the missing bones at runtime: drop a fresh bone into a body region, re-skin
 * the nearby verts onto it (the bind pose is preserved because every bone resolves to
 * identity at bind), then drive it with a translation spring. The skinned mesh now has
 * localized secondary motion — chest + rear bounce — with zero Blender round-trip.
 *
 * Aim/feel is on the Leva panel; if a region is off, nudge the offsets here.
 */
type JiggleDef = {
  key: string
  boneName: string // unique name for the injected bone (so remount reuses it)
  anchor: string // existing bone we hang it under (and that drives its rest)
  offset: [number, number, number] // region centre, world axes, relative to anchor
  radius: number // selection radius around the centre (model-local units)
  phase: number // desync the idle wobble between parts
}

// NOTE: this rig is T-posed with arms along Z, so her left<->right axis is Z and
// "forward" is +X (front) / -X (back). Region centres below are measured off the
// actual mesh (breast tips ~x0.095,y0.73,z±0.05; glute tips ~x-0.07,y0.53,z±0.04).
const JIGGLES: JiggleDef[] = [
  // one bone PER breast: forward (+X) + up, split left/right on Z
  { key: 'chest_L', boneName: 'Jiggle_chest_L', anchor: 'Spine02', offset: [0.067, 0.044, 0.053], radius: 0.06, phase: 0.4 },
  { key: 'chest_R', boneName: 'Jiggle_chest_R', anchor: 'Spine02', offset: [0.067, 0.044, -0.047], radius: 0.06, phase: 1.1 },
  // one bone PER cheek: back (-X) + slightly down, split left/right on Z
  { key: 'rear_L', boneName: 'Jiggle_rear_L', anchor: 'Pelvis', offset: [-0.065, -0.014, 0.04], radius: 0.065, phase: 1.7 },
  { key: 'rear_R', boneName: 'Jiggle_rear_R', anchor: 'Pelvis', offset: [-0.065, -0.014, -0.04], radius: 0.065, phase: 2.4 },
]

const MAX_BLEND = 0.8 // how strongly region verts follow the jiggle bone

type Spring = {
  def: JiggleDef
  bone: THREE.Bone
  anchor: THREE.Object3D
  restLocal: THREE.Vector3 // bone rest position in anchor-local space
  maxDisp: number // clamp (model-local units)
  pos: THREE.Vector3 // dynamic world pos
  prevPos: THREE.Vector3
  seeded: boolean
}

function scaleOf(m: THREE.Matrix4) {
  return new THREE.Vector3().setFromMatrixColumn(m, 0).length() || 1
}

export function Wiggle() {
  const { scene } = useGLTF(CHARACTER_URL)
  const springs = useRef<Spring[]>([])
  const wasEnabled = useRef(false)

  const { enabled, amount, stiffness, damping, droop, idle } = useControls(
    '4 · jiggle (her body)',
    {
      enabled: { value: true, label: 'jiggle bones' },
      amount: { value: 1, min: 0, max: 1.5, step: 0.01, label: 'amount' },
      stiffness: { value: 14, min: 1, max: 30, step: 0.5 },
      damping: { value: 0.12, min: 0, max: 0.6, step: 0.01, label: 'damping (low=bouncy)' },
      droop: { value: 0.3, min: 0, max: 3, step: 0.05, label: 'gravity' },
      idle: { value: 0.7, min: 0, max: 3, step: 0.05, label: 'idle life' },
      nudge: button(() => {
        // kick every part down + along its natural axis (chest forward +X, rear back -X)
        for (const s of springs.current) {
          s.prevPos.y += 0.05
          s.prevPos.x += s.def.key.startsWith('chest') ? 0.03 : -0.03
        }
      }),
    },
  )

  useEffect(() => {
    let mesh: THREE.SkinnedMesh | undefined
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (m.isSkinnedMesh && !mesh) mesh = m
    })
    if (!mesh) return
    scene.updateMatrixWorld(true)
    mesh.updateWorldMatrix(true, false)
    const skel = mesh.skeleton
    const byName = (n: string) => skel.getBoneByName(n)

    // already injected on this cached scene (we remounted)? just re-grab the bones.
    const alreadyInjected = JIGGLES.every((d) => byName(d.boneName))

    const newBones: THREE.Bone[] = []
    const newInverses: THREE.Matrix4[] = []
    const built: Spring[] = []

    const posAttr = mesh.geometry.attributes.position
    const idxAttr = mesh.geometry.attributes.skinIndex as THREE.BufferAttribute
    const wAttr = mesh.geometry.attributes.skinWeight as THREE.BufferAttribute
    const vWorld = new THREE.Vector3()
    const centerWorld = new THREE.Vector3()

    for (const def of JIGGLES) {
      const anchor = byName(def.anchor)
      if (!anchor) continue
      const scale = scaleOf(anchor.matrixWorld)
      anchor.getWorldPosition(centerWorld)
      centerWorld.x += def.offset[0] * scale
      centerWorld.y += def.offset[1] * scale
      centerWorld.z += def.offset[2] * scale

      let bone = byName(def.boneName) as THREE.Bone | undefined

      if (!alreadyInjected && !bone) {
        // 1. create the bone at the region centre, parented to the anchor
        bone = new THREE.Bone()
        bone.name = def.boneName
        bone.position.copy(anchor.worldToLocal(centerWorld.clone()))
        anchor.add(bone)
        bone.updateMatrixWorld(true)
        // boneInverse so the bone resolves to identity at bind (bind pose unchanged)
        const inv = bone.matrixWorld.clone().invert()
        newBones.push(bone)
        newInverses.push(inv)

        // 2. re-skin verts within radius onto the new bone (index assigned below)
        const jointIndex = skel.bones.length + newBones.length - 1
        const r = def.radius * scale
        for (let i = 0; i < posAttr.count; i++) {
          vWorld.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld)
          const d = vWorld.distanceTo(centerWorld)
          if (d >= r) continue
          const t = 1 - d / r
          const f = t * t * (3 - 2 * t) // smoothstep falloff
          const blend = f * MAX_BLEND
          if (blend <= 0.001) continue
          const ix = [idxAttr.getX(i), idxAttr.getY(i), idxAttr.getZ(i), idxAttr.getW(i)]
          const wt = [wAttr.getX(i), wAttr.getY(i), wAttr.getZ(i), wAttr.getW(i)]
          // drop the least-influential slot, give it to the jiggle bone, renormalise
          let s = 0
          for (let k = 1; k < 4; k++) if (wt[k] < wt[s]) s = k
          ix[s] = jointIndex
          wt[s] = 0
          for (let k = 0; k < 4; k++) wt[k] *= 1 - blend
          wt[s] = blend
          const sum = wt[0] + wt[1] + wt[2] + wt[3] || 1
          idxAttr.setXYZW(i, ix[0], ix[1], ix[2], ix[3])
          wAttr.setXYZW(i, wt[0] / sum, wt[1] / sum, wt[2] / sum, wt[3] / sum)
        }
      }
      if (!bone) continue
      built.push({
        def,
        bone,
        anchor,
        restLocal: bone.position.clone(),
        maxDisp: def.radius * 0.6,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        seeded: false,
      })
    }

    // 3. one rebind with all the new bones (rebuilds the bone texture once)
    if (newBones.length) {
      idxAttr.needsUpdate = true
      wAttr.needsUpdate = true
      const sk = new THREE.Skeleton([...skel.bones, ...newBones], [...skel.boneInverses, ...newInverses])
      mesh.bind(sk, mesh.bindMatrix)
    }

    springs.current = built

    return () => {
      // park every jiggle bone back at rest so other modes (ragdoll) see a clean pose
      for (const s of springs.current) {
        s.bone.position.copy(s.restLocal)
        s.bone.updateMatrixWorld(true)
      }
      springs.current = []
    }
  }, [scene])

  // scratch
  const restWorld = useRef(new THREE.Vector3())
  const next = useRef(new THREE.Vector3())
  const inertia = useRef(new THREE.Vector3())
  const disp = useRef(new THREE.Vector3())
  const out = useRef(new THREE.Vector3())

  useFrame((state, delta) => {
    const list = springs.current
    if (!list.length) return

    if (!enabled) {
      if (wasEnabled.current) {
        for (const s of list) {
          s.bone.position.copy(s.restLocal)
          s.bone.updateMatrixWorld(true)
          s.seeded = false
        }
        wasEnabled.current = false
      }
      return
    }
    wasEnabled.current = true

    const dt = Math.min(delta, 1 / 30)
    const t = state.clock.elapsedTime

    for (const s of list) {
      s.anchor.updateWorldMatrix(true, false)
      const scale = scaleOf(s.anchor.matrixWorld)
      restWorld.current.copy(s.restLocal).applyMatrix4(s.anchor.matrixWorld)

      if (!s.seeded) {
        s.pos.copy(restWorld.current)
        s.prevPos.copy(restWorld.current)
        s.seeded = true
      }

      // verlet inertia + Hooke pull back to rest + gravity + gentle idle life
      inertia.current.copy(s.pos).sub(s.prevPos).multiplyScalar(1 - damping)
      next.current
        .copy(s.pos)
        .add(inertia.current)
        .addScaledVector(restWorld.current.clone().sub(s.pos), stiffness * dt)
      next.current.y -= droop * dt * scale
      next.current.y += Math.sin(t * 6 + s.def.phase) * idle * 0.004 * scale
      next.current.x += Math.cos(t * 4.3 + s.def.phase) * idle * 0.003 * scale

      // clamp displacement so a hard kick can't tear the mesh
      disp.current.copy(next.current).sub(restWorld.current)
      const max = s.maxDisp * scale
      if (disp.current.length() > max) disp.current.setLength(max)
      next.current.copy(restWorld.current).add(disp.current)

      s.prevPos.copy(s.pos)
      s.pos.copy(next.current)

      // `amount` scales the visible bounce; physics still runs full
      out.current.copy(restWorld.current).lerp(s.pos, amount)
      s.bone.position.copy(s.anchor.worldToLocal(out.current.clone()))
      s.bone.updateMatrixWorld(true)
    }
  })

  // drives bones on the shared (cached) character scene — CharacterMesh renders it.
  return null
}
