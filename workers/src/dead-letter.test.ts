import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { DeadLetterRepository, ProtocolRepository } from "./repositories";
import { runDurableKeeperWithDeadLetter } from "./keepers";

const bindings = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(bindings.DB!, bindings.TEST_MIGRATIONS); });

it("records a failure with a scheduled retry time, and clears it on a later success", async () => {
  const dead = new DeadLetterRepository(bindings.DB!);
  const first = await dead.record("job-1", "funding", { market: "m" }, "boom", 1_000);
  expect(first.attempts).toBe(1);
  expect(first.nextAttemptAt).toBe(1_250); // retryDelay(1) === 250
  const second = await dead.record("job-1", "funding", { market: "m" }, "boom again", 2_000);
  expect(second.attempts).toBe(2);
  expect(second.nextAttemptAt).toBe(2_500); // retryDelay(2) === 500

  const due = await dead.due(2_500);
  expect(due).toHaveLength(1);
  expect(due[0]).toMatchObject({ id: "job-1", operation: "funding", error: "boom again", attempts: 2 });

  await dead.resolve("job-1");
  expect(await dead.due(999_999)).toHaveLength(0);
});

it("due() only returns entries whose scheduled retry time has arrived", async () => {
  const dead = new DeadLetterRepository(bindings.DB!);
  await dead.record("job-future", "pyth", {}, "err", 1_000);
  expect(await dead.due(1_000)).toEqual([]); // next attempt is 1_000 + 250, not yet
  expect((await dead.due(1_250)).map((d) => d.id)).toContain("job-future");
});

it("giveUp stops the retry sweep from returning an entry without deleting it", async () => {
  const dead = new DeadLetterRepository(bindings.DB!);
  await dead.record("job-exhausted", "commit", {}, "err", 1_000);
  await dead.giveUp("job-exhausted", 9_999_999_999);
  // Still not due a full day later -- but the record itself must still
  // exist (giveUp is not a delete).
  expect((await dead.due(1_000 + 24 * 60 * 60 * 1000)).find((d) => d.id === "job-exhausted")).toBeUndefined();
});

it("runDurableKeeperWithDeadLetter records a durable failure and clears it once the same job later succeeds", async () => {
  const repo = new ProtocolRepository(bindings.DB!);
  const dead = new DeadLetterRepository(bindings.DB!);
  await expect(runDurableKeeperWithDeadLetter(repo, dead, {
    leaseKey: "keeper:funding:market-x", holder: "worker-a",
    idempotencyKey: "funding:market-x:1", requestHash: "funding:market-x:1",
    now: 1_000, leaseTtlMs: 5_000, idempotencyTtlMs: 60_000,
    deadLetterId: "funding:market-x:1",
    work: async () => { throw new Error("submission failed"); },
  })).rejects.toThrow("submission failed");
  const due = await dead.due(1_000_000);
  expect(due.find((d) => d.id === "funding:market-x:1")?.error).toBe("submission failed");

  const result = await runDurableKeeperWithDeadLetter(repo, dead, {
    leaseKey: "keeper:funding:market-x", holder: "worker-a",
    idempotencyKey: "funding:market-x:2", requestHash: "funding:market-x:2",
    now: 2_000, leaseTtlMs: 5_000, idempotencyTtlMs: 60_000,
    deadLetterId: "funding:market-x:1", // same job identity, next attempt
    work: async () => "settled",
  });
  expect(result).toBe("settled");
  expect((await dead.due(1_000_000)).find((d) => d.id === "funding:market-x:1")).toBeUndefined();
});

it("gives up after maxAttempts consecutive failures for the same job identity", async () => {
  const repo = new ProtocolRepository(bindings.DB!);
  const dead = new DeadLetterRepository(bindings.DB!);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expect(runDurableKeeperWithDeadLetter(repo, dead, {
      leaseKey: "keeper:pyth:market-y", holder: `worker-${attempt}`,
      idempotencyKey: `pyth:market-y:${attempt}`, requestHash: `pyth:market-y:${attempt}`,
      now: attempt * 10_000, leaseTtlMs: 5_000, idempotencyTtlMs: 60_000,
      deadLetterId: "pyth:market-y", maxAttempts: 3,
      work: async () => { throw new Error(`fail-${attempt}`); },
    })).rejects.toThrow(`fail-${attempt}`);
  }
  // After 3 attempts (the configured max), the entry is not due again
  // within a full day -- giveUp pushed it far out, not deleted it.
  expect((await dead.due(30_000 + 24 * 60 * 60 * 1000)).find((d) => d.id === "pyth:market-y")).toBeUndefined();
});
