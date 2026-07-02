import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

const CHARACTER_URL = '/models/fermme.glb'

/**
 * Each segment is a capsule rigid body spanning boneA -> boneB. We drive boneA's
 * world transform from the body every frame, so the skinned mesh flops with the
 * physics. Twist/leaf bones just inherit.
 */
const SEGMENTS: [string, string][] = [
  ['Waist', 'Spine01'], // 0  lower torso (root body)
  ['Spine01', 'Spine02'], // 1  upper torso
  ['Spine02', 'Head'], // 2  chest -> head
  ['L_Upperarm', 'L_Forearm'], // 3
  ['L_Forearm', 'L_Hand'], // 4
  ['R_Upperarm', 'R_Forearm'], // 5
  ['R_Forearm', 'R_Hand'], // 6
  ['L_Thigh', 'L_Calf'], // 7
  ['L_Calf', 'L_Foot'], // 8
  ['R_Thigh', 'R_Calf'], // 9
  ['R_Calf', 'R_Foot'], // 10
]

// [childSegment, parentSegment] — jointed at the child segment's first bone.
const LINKS: [number, number][] = [
  [1, 0], [2, 1],
  [3, 2], [4, 3], // left arm off the chest
  [5, 2], [6, 5], // right arm off the chest
  [7, 0], [8, 7], // left leg off the lower torso
  [9, 0], [10, 9], // right leg off the lower torso
]

// physics ground is a fixed ball matching the visible planet; radius comes in as a prop
const GROUP_RAGDOLL = (0x0002 << 16) | 0x0001 // collides only with the planet, never itself
const GROUP_PLANET = (0x0001 << 16) | 0x0002

type Seg = {
  bone: THREE.Bone
  parent: THREE.Object3D
  body: any
  halfLen: number
  qOffset: THREE.Quaternion // body-rest -> bone-rest, so rest pose is reproduced
}

/**
 * Ragdoll mode: builds a physics skeleton from her bones, lets gravity take her,
 * and writes the result back onto the skin. Toggle off to restore the posed mesh.
 */
export function Ragdoll({ planetRadius = 3 }: { planetRadius?: number }) {
  const { scene } = useGLTF(CHARACTER_URL)
  const { world, rapier } = useRapier()
  const segs = useRef<Seg[]>([])
  const handles = useRef<{ bodies: any[]; joints: any[]; ground?: any }>({ bodies: [], joints: [] })

  useEffect(() => {
    let skinned: THREE.SkinnedMesh | undefined
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh
      if (m.isSkinnedMesh && !skinned) skinned = m
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false
    })
    if (!skinned) return
    scene.updateMatrixWorld(true)
    const skel = skinned.skeleton
    const byName = (n: string) => skel.getBoneByName(n)

    const built: Seg[] = []
    const tmpA = new THREE.Vector3()
    const tmpB = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)

    for (const [a, b] of SEGMENTS) {
      const boneA = byName(a)
      const boneB = byName(b)
      if (!boneA || !boneB || !boneA.parent) {
        built.push(null as unknown as Seg)
        continue
      }
      boneA.getWorldPosition(tmpA)
      boneB.getWorldPosition(tmpB)
      const dir = tmpB.clone().sub(tmpA)
      const len = Math.max(dir.length(), 0.02)
      dir.normalize()
      const mid = tmpA.clone().addScaledVector(dir, len / 2)
      // body local +Y aligned to the bone direction
      const qBody = new THREE.Quaternion().setFromUnitVectors(up, dir)
      const boneRestQ = new THREE.Quaternion()
      boneA.getWorldQuaternion(boneRestQ)
      const qOffset = qBody.clone().invert().multiply(boneRestQ)

      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: qBody.x, y: qBody.y, z: qBody.z, w: qBody.w })
          .setLinearDamping(0.4)
          .setAngularDamping(0.6),
      )
      const radius = Math.min(0.09, len * 0.4)
      const col = rapier.ColliderDesc.capsule(Math.max(len / 2 - radius, 0.01), radius)
        .setDensity(1)
      const collider = world.createCollider(col, body)
      collider.setCollisionGroups(GROUP_RAGDOLL)

      built.push({ bone: boneA, parent: boneA.parent, body, halfLen: len / 2, qOffset })
      handles.current.bodies.push(body)
    }

    // joints at the shared bone position
    const anchorLocal = (body: any, worldPos: THREE.Vector3) => {
      const t = body.translation()
      const r = body.rotation()
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert()
      return worldPos.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(q)
    }
    for (const [child, parent] of LINKS) {
      const cs = built[child]
      const ps = built[parent]
      if (!cs || !ps) continue
      const jointWorld = cs.bone.getWorldPosition(new THREE.Vector3())
      const a1 = anchorLocal(ps.body, jointWorld)
      const a2 = anchorLocal(cs.body, jointWorld)
      const params = rapier.JointData.spherical(
        { x: a1.x, y: a1.y, z: a1.z },
        { x: a2.x, y: a2.y, z: a2.z },
      )
      const j = world.createImpulseJoint(params, ps.body, cs.body, true)
      handles.current.joints.push(j)
    }

    // a fixed ground ball so she lands on the planet instead of falling forever
    const ground = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(0, -planetRadius, 0),
    )
    const gcol = world.createCollider(rapier.ColliderDesc.ball(planetRadius), ground)
    gcol.setCollisionGroups(GROUP_PLANET)
    handles.current.ground = ground

    segs.current = built.filter(Boolean) as Seg[]

    return () => {
      // tear the physics skeleton down and let the mesh snap back to its pose
      for (const j of handles.current.joints) world.removeImpulseJoint(j, true)
      for (const b of handles.current.bodies) world.removeRigidBody(b)
      if (handles.current.ground) world.removeRigidBody(handles.current.ground)
      handles.current = { bodies: [], joints: [] }
      segs.current = []
      scene.traverse((o) => {
        const b = o as THREE.Bone
        if (b.isBone) b.matrixWorldNeedsUpdate = true
      })
    }
  }, [scene, world, rapier, planetRadius])

  const pos = useRef(new THREE.Vector3())
  const quat = useRef(new THREE.Quaternion())
  const dir = useRef(new THREE.Vector3())
  const m4 = useRef(new THREE.Matrix4())
  const pInv = useRef(new THREE.Matrix4())

  useFrame(() => {
    for (const s of segs.current) {
      const t = s.body.translation()
      const r = s.body.rotation()
      quat.current.set(r.x, r.y, r.z, r.w)
      // boneA world pos = body midpoint - halfLen along the body's current +Y
      dir.current.set(0, 1, 0).applyQuaternion(quat.current)
      pos.current.set(t.x, t.y, t.z).addScaledVector(dir.current, -s.halfLen)
      // boneA world rotation = bodyRot * restOffset
      const worldQ = quat.current.clone().multiply(s.qOffset)

      s.parent.updateWorldMatrix(true, false)
      pInv.current.copy(s.parent.matrixWorld).invert()
      m4.current.compose(pos.current, worldQ, new THREE.Vector3(1, 1, 1))
      m4.current.premultiply(pInv.current)
      m4.current.decompose(s.bone.position, s.bone.quaternion, new THREE.Vector3())
      s.bone.updateMatrixWorld(true)
    }
  })

  return <primitive object={scene} />
}
