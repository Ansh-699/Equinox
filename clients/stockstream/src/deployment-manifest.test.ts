import { describe, expect, it } from "vitest";
import deployment from "../../../config/stockstream-deployment.json";
import { STOCKSTREAM_PROGRAM_ID } from "./constants";

describe("deployment manifest", () => {
  it("has one explicit public deployment identity", () => {
    expect(STOCKSTREAM_PROGRAM_ID).toBe(deployment.programId);
    expect(deployment.cluster).toBe("devnet");
    expect(deployment.writeEnabled).toBe(false);
    expect(deployment.oracle).toMatchObject({ feedId: 1435, channelId: 2, exponent: -5 });
  });

  it("does not expose an abandoned zero-mint market as the demo", () => {
    expect(deployment.core).toBeNull();
    expect(deployment.collateralMint).toBeNull();
    expect(deployment.exchange).toBeNull();
    expect(deployment.instrument).toBeNull();
  });
});
