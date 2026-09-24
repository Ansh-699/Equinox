import { describe, expect, it } from "vitest";
import deployment from "../../../config/equinox-deployment.json";
import { EQUINOX_PROGRAM_ID } from "./constants";

describe("deployment manifest", () => {
  it("has one explicit public deployment identity", () => {
    expect(EQUINOX_PROGRAM_ID).toBe(deployment.programId);
    expect(deployment.cluster).toBe("devnet");
    expect(deployment.writeEnabled).toBe(false);
    expect(deployment.oracle).toMatchObject({ feedId: 1435, channelId: 2, exponent: -5 });
  });

  it("exposes only the lifecycle-verified market with a real collateral mint", () => {
    expect(deployment.status).toBe("devnet-lifecycle-verified");
    expect(deployment.localArtifactSha256).toBe(deployment.deployedArtifactSha256);
    for (const key of ["exchange", "instrument", "core", "oracleSnapshot", "collateralMint", "lookupTable"] as const) {
      expect(deployment[key]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
    expect(deployment.core).not.toBe("82yWLiEcbcszxGgxouGRFMX7BaYWNAVboU7aVnDaxK34");
  });
});
