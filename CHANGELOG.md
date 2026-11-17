# Changelog

Notable changes to Ecctrl are documented here.

## Unreleased

- **Breaking:** `ShapeCastWheel` props `minLngRelaxCoeff` / `minLatRelaxCoeff` (fixed per-frame coefficient, default `0.3`) are renamed to `minLngRelaxRate` / `minLatRelaxRate` (per-second rate, default `21.4`). Tire response is now the same at any step size and matches the old behavior at 60 Hz.
- A sleeping vehicle now wakes only on throttle input or when a grounded wheel is on a moving platform. Leftover wheel spin no longer wakes a parked car and bumps it. Brake or steer alone keep it asleep; collisions and impulses still wake it through Rapier.
- Wheels clear their spin and friction state when the vehicle falls asleep, and skip friction and rotation math while asleep with no throttle. The ground cast keeps running so moving platforms still wake the car.
- Fixed wheel spin flipping direction frame to frame while settling: the smoothed longitudinal friction impulse no longer overshoots the impulse that stops the wheel.
- Debug: the blue suspension arrow now draws wheel load (force / g) instead of impulse, so it no longer flickers with frame time under `timeStep="vary"`. It draws longer than before at the same `debuggerArrowScale`. Green and red arrows clear to zero when the vehicle falls asleep.
- Docs: `<Physics>` examples now use `timeStep="vary"`, with a note on why.

## 2.0.2 - 2026-09-06

- Fixed a bug where ground information only refreshed after releasing and pressing a movement key again.

## 2.0.1 - 2026-08-16

- Improved joystick tracking and removed drag jitter on lower-frame-rate touch devices.
- Added reliable pointer capture, cancellation, and multi-touch handling to the joystick and virtual buttons.
- Reduced touch-control renders, layout reads, and redundant store updates.
