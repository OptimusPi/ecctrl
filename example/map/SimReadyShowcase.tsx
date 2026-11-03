import { Suspense, useEffect, useRef, type RefObject } from "react";
import { button, useControls } from "leva";
import {
  SimReadyStage,
  useSimReadyUSD,
  type SimReadyStageHandle,
} from "../../src/simready";
import { useToolGunStore } from "../toolgun/useToolGunStore";
import { usePeerStore } from "../webmcp/usePeerStore";

export type SimReadyShowcaseProps = {
  paused?: boolean;
  timeScale?: number | RefObject<number>;
};

export function SimReadyShowcase({
  paused = false,
  timeScale = 1,
}: SimReadyShowcaseProps) {
  const bayRef = useRef<SimReadyStageHandle>(null);
  const pod1Ref = useRef<SimReadyStageHandle>(null);
  const pod2Ref = useRef<SimReadyStageHandle>(null);

  useEffect(() => {
    usePeerStore.getState().setResetSimReadyStagesCallback(() => {
      bayRef.current?.reset();
      pod1Ref.current?.reset();
      pod2Ref.current?.reset();
    });
    return () => usePeerStore.getState().setResetSimReadyStagesCallback(null);
  }, []);

  const { enabled, syncUsdGravity } = useControls(
    "SimReady OpenUSD",
    {
      enabled: { value: true, label: "Enable Bay (.usdz + .usdc)" },
      syncUsdGravity: { value: false, label: "Use USD PhysicsScene Gravity" },
      "Pop Crates (Q1065449)": button(() => {
        bayRef.current?.getBodiesBySemantic("Q1065449").forEach((rb) => {
          rb.applyImpulse({ x: 0, y: 120, z: 0 }, true);
        });
      }),
      "Pop Pallets (Q5153359)": button(() => {
        bayRef.current?.getBodiesBySemantic("Q5153359").forEach((rb) => {
          rb.applyImpulse({ x: 0, y: 165, z: 0 }, true);
        });
      }),
      "Launch USDC Pods (Q11012)": button(() => {
        [pod1Ref.current, pod2Ref.current].forEach((stage) => {
          stage?.getBodiesBySemantic("Q11012").forEach((rb) => {
            rb.applyImpulse({ x: 0, y: 115, z: 0 }, true);
          });
        });
      }),
      "Swing Pendulum (Q207621)": button(() => {
        bayRef.current?.getBodiesBySemantic("Q207621").forEach((rb) => {
          rb.applyImpulse({ x: -240, y: 35, z: 140 }, true);
        });
      }),
      "Reset SimReady Stage": button(() => {
        useToolGunStore.getState().clearAllToolGunItems();
        bayRef.current?.reset();
        pod1Ref.current?.reset();
        pod2Ref.current?.reset();
      }),
    },
    { collapsed: true }
  );

  if (!enabled) return null;

  return (
    <Suspense fallback={null}>
      {/* Multi-layer Z-up SimReady USDZ bay (pallets, crates, drums, PTFE slide, trimesh ramps, 4 joints/drives) */}
      <SimReadyStage
        ref={bayRef}
        url="/simready/warehouse_bay.usdz"
        position={[0, 0, -85]}
        enableCustomGravity
        syncPhysicsSceneGravity={syncUsdGravity}
        paused={paused}
        timeScale={timeScale}
      />

      {/* Binary Crate PXR-USDC SimReady sensor pods (TokenListOp apiSchemas + compound colliders + Q11012) */}
      <SimReadyStage
        ref={pod1Ref}
        url="/simready/sensor_pod.usdc"
        position={[-1.8, 2.2, -83.5]}
        enableCustomGravity
        paused={paused}
        timeScale={timeScale}
      />
      <SimReadyStage
        ref={pod2Ref}
        url="/simready/sensor_pod.usdc"
        position={[-1.8, 3.6, -86.5]}
        enableCustomGravity
        paused={paused}
        timeScale={timeScale}
      />
    </Suspense>
  );
}

useSimReadyUSD.preload([
  "/simready/warehouse_bay.usdz",
  "/simready/sensor_pod.usdc",
]);
