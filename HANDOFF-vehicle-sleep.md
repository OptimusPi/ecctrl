# Handoff: vehicle sleep/wake bump + parked-car cost

Repo: ecctrl 2.0.2 (beta, breaking changes OK). Branch `bugfix/rapier-body-sleeping-bump`, no commits yet.
Target: any number of cars in one scene. Parked cars must stay still, cost almost nothing, and wake on throttle, contact, or a hit.

Every claim below is tagged **[read]** (verified by reading the cited code) or **[unverified]**.

## Working tree right now (uncommitted)

- `src/vehicles/components/ShapeCastWheel.tsx:919-920`. A 3-line patch zeroes `wheelAngVel` when the body is asleep and `driveTorque === 0`. It hides finding F1 and nothing else. Replace it with P2.
- `ShapeCastWheel.tsx:61-62, 791-795`. The props `minLngRelaxCoeff`/`minLatRelaxCoeff` (fixed 0.3 per frame) were renamed to `minLngRelaxRate`/`minLatRelaxRate` (default 21.4 per second), with the floor computed as `1 - exp(-rate * world.timestep)`. This is identical to the old behavior at 60 Hz. The example (`example/EcctrlWrapper.tsx:455-456, 561-562`) and docs (`docs/api-reference.md:444-445, 479`) are updated. Keep this change.
- `readme.md` and `docs/api-reference.md`. Every `<Physics>` snippet now has `timeStep="vary"`, and a note was added at `docs/api-reference.md:50`. Keep this change.
- `npm run typecheck` and `npm run build` pass. None of it has been run in the app.

## Findings

**F1. The wake rule uses wheel spin as a stand-in for input.** [read]
`EcctrlVehicle.tsx:515-528`: a sleeping body wakes if any grounded wheel has `|wheelLinVel| > 1e-4` or `isOnPlatform`. After that, lines 533-535 apply the suspension and friction impulses to the body.
Spin left over from before the car fell asleep passes the check. The car wakes, and the friction impulse, which tries to stop the wheel, shoves the chassis. That shove is the bump.
`1e-4` is a hand-picked literal used for unrelated quantities in six places. It doesn't come from Rapier.

**F2. The friction relax loop always oscillates.** [read; math derived, not measured]
With the body still (contact velocity 0), each frame does the following, where σ is the smoothed impulse in wheel-speed units and a is the relax floor:
- `desired = ω` (line 778: `slipDiff * I / r²`, which is enough to stop the wheel in one frame)
- `σ' = σ + a(ω − σ)` (line 797)
- `ω' = ω − σ'` (line 814)

The matrix `[[1−a, a], [−(1−a), 1−a]]` has eigenvalues `(1−a) ± i·√(a(1−a))`. They are complex for every a in (0, 1), and their magnitude is `√(1−a)`, which is 0.837 at a = 0.3.
Result: the wheel spin flips sign every few frames as it decays. While the car is awake, the same impulse rocks the chassis. This slows settling and feeds F1.
The coupled case (body awake and responding) wasn't analyzed.

**F3. Parked cars still pay full wheel cost every frame.** [read; cost not measured]
`ShapeCastWheel.tsx:910-960`: the wheel's `useFrame` has no sleep gate. Each frame it runs the shape cast, platform detect, friction math and rotation solve, even while the body is asleep.
Cost grows with every parked car: 4 shape casts per car per frame, doing nothing.

**F4. Rapier's sleep tuning isn't exposed in JS.** [read]
`@dimforge/rapier3d-compat` 0.19.2 exposes only `canSleep`, `setCanSleep` and `setSleeping` (`rigid_body.d.ts:531, 720, 726`). The velocity thresholds and the time before sleep are internal.
[measured, rapier3d-compat 0.19.2, headless Node] Rapier zeroes linear and angular velocity when it auto-sleeps a body. A resting box slept after exactly 2.000 s at both 60 Hz and 120 Hz steps (sleep timing is time-based, not step-based).
[measured] `applyImpulse(imp, false)` on a sleeping body is stored in its velocity while the body stays asleep (|v| 0 -> 100, sleeping=true). On wake, that stored velocity is applied at once. Any wakeUp=false impulse on a sleeping body is therefore a latent bump.
[read] No Ecctrl code path applies impulses to a sleeping car: `applyGravityField` returns if sleeping (`src/gravity/useCustomGravity.ts`), and `applyWheelImpulse` returns before impulses unless waking. Drone air drag runs while asleep but is built from linvel, which is zero.

**F5. A car on a moving platform has no contact-based wake.** [read]
The chassis floats on wheel casts, so it never touches the platform collider. Rapier's automatic contact wake (`rigid_body.d.ts:314-316`) doesn't apply. Platform detection depends on the wheel cast running, which constrains any fix for F3.

**F6. All Ecctrl impulses run in `useFrame`, not per physics step.** [read]
These include the character, wheels, propellers and custom gravity (`Ecctrl.tsx:957`, `EcctrlVehicle.tsx:426, 533-535, 742`, readme custom-body example).
With fixed-step `<Physics>`, the force applied per step scales with frames per step. The docs now require `timeStep="vary"` as a workaround. The real fix is moving the logic to `useBeforePhysicsStep` (`react-three-rapier.esm.js:528`, called before every `world.step` at 885-887).
Out of scope here, but don't make it worse.

## Fix plan

**P1. Wake on intent, not spin.** Applies to `EcctrlVehicle.tsx`.
`driveIn` is computed in `velocityBasedCarControl` (line 501). Store it in a ref, or return it.
In `applyWheelImpulse`, set `shouldWake = driveIn !== 0 || anyWheel.isOnPlatform`, and delete the `wheelLinVel` test. Brake or steer alone should not wake the car.
Keep the impulses at `wakeUp = false`; with `true`, the car never sleeps.

**P2. Reset wheel transients on the awake→asleep edge.** Applies to `ShapeCastWheel.tsx`.
Track the previous `isSleeping()`. On the frame it becomes true, zero `wheelAngVel`, `smoothedLngImpulse`, `smoothedLatImpulse`, `lngFrictionImp` and `latFrictionImp`. Do this once, not every frame.
Remove the current 3-line patch.

**P3. Gate wheel work while asleep.** Applies to the `ShapeCastWheel.tsx` `useFrame`.
If the body is asleep and `driveDemand.current === 0`, skip the friction math, the rotation solve and the stand-collider impulses.
Constraint from F5: the cast must still run, or platforms break. Two options:
- (a) Keep casting every frame and skip the rest. This is cheaper but still casts 4 times per parked car per frame.
- (b) Cast every Nth frame while asleep. If a platform is hit, run the full update and let P1 wake the car.

Measure before choosing.
[unverified] Wheel `useFrame` runs before the vehicle's `useFrame` each frame (children subscribe first). Confirm this, because a wheel that skips its update on the wake frame hands the vehicle stale impulses.

**P4. Stop the relax loop overshooting (F2).** Applies to `ShapeCastWheel.tsx:797-798`.
After the blend, clamp `smoothedLngImpulse` so it never exceeds `desiredLngImpulse` in the same direction, and set it to zero if the signs differ. Then `ω'` can't change sign.
Apply the same clamp to the lateral impulse only if tests show it oscillates too.
This is a proposal. Verify that low-speed grip and drive feel don't regress.

## Verification

1. `npm run typecheck`, `npm run build`.
2. Real refresh-rate test: System Settings → Displays → Refresh Rate, comparing ProMotion with 60 Hz, and reload the example. Don't fake FPS in code.
3. Bump test: drive a car slowly, release, and watch through the sleep transition. With `debug` on, nothing should jump. Repeat on a slope and on a moving platform. The platform case must still wake the car (F5).
4. Wake test: from sleep, throttle wakes it on the next frame, while brake or steer alone don't.
5. External wake test. Sleep doesn't remove colliders, so a parked car must still react to hits:
   - Ram a sleeping car with another car. Rapier's contact wake (`rigid_body.d.ts:314-316`) must fire, and the wheels must resume and suspend normally.
   - Hit it with a raycast plus `applyImpulse(imp, true)`. The `true` must wake it (`rigid_body.d.ts:63`).
   - With P3 in place, the wheel gate must read `isSleeping()` fresh each frame, so a contact wake isn't ignored.
6. Scale test: many parked cars. Record frame time and Rapier step time before and after P3.
7. No Leva tuning value should need to change for the 60 Hz feel to match the current build.

## Loose ends (not part of this fix)

- `readme.md:262` and `example/EcctrlWrapper.tsx:801` use `camera.up.lerp(..., 0.1)` per frame, which depends on frame rate. Use `1 - Math.exp(-rate * delta)`.
- `readme.md:641` says TimeControl gives "deterministic" controls. It doesn't, because `vary` steps change with frame time.
- `CHANGELOG.md` needs an entry for the `minL*RelaxCoeff → minL*RelaxRate` rename.
