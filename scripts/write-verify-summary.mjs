#!/usr/bin/env node
/** Convert the logs emitted by scripts/verify.sh into a small, reviewable
 * machine-readable gate record. No credentials or command environments are
 * persisted; only test counts, checks, commit and artifact identity are
 * recorded. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const [logDir, outputPath] = process.argv.slice(2);
if (!logDir || !outputPath) throw new Error("usage: write-verify-summary.mjs LOG_DIR OUTPUT_PATH");
// Vitest colorizes its summary when a TTY is inferred, which would otherwise
// break the count regexes below. Strip ANSI SGR sequences before parsing.
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const read = (name) => stripAnsi(fs.readFileSync(`${logDir}/${name}.log`, "utf8"));
const first = (text, pattern, label) => {
  const match = text.match(pattern);
  if (!match) throw new Error(`could not derive ${label} from verification log`);
  return Number(match[1]);
};

const rustLog = read("rust-tests");
const rustMatches = [...rustLog.matchAll(/test result: ok\.\s+(\d+) passed/g)];
if (!rustMatches.length) throw new Error("could not derive Rust test count from verification log");
const rustTests = rustMatches.reduce((sum, match) => sum + Number(match[1]), 0);
const frontendTests = first(read("frontend-tests"), /Tests\s+(\d+)\s+passed/, "frontend test count");
const workerTests = first(read("worker-tests"), /Tests\s+(\d+)\s+passed/, "Worker test count");
const playwrightTests = first(read("playwright"), /(?:Running\s+\d+\s+tests[\s\S]*?\n\s*)?(\d+)\s+passed\s+\(/, "Playwright test count");
const artifactPath = `${process.cwd()}/target/deploy/equinox.so`;
const artifactSha256 = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const abiOk = read("abi").includes("ABI-OK");
const v3LayoutFixture = read("v3-layout-fixture").includes("V3-LAYOUT-FIXTURE-OK");
const secretScanOk = read("secrets").includes("secret-scan: OK");
if (!abiOk || !v3LayoutFixture || !secretScanOk)
  throw new Error("verification logs do not contain ABI-OK, V3-LAYOUT-FIXTURE-OK and secret-scan: OK");

const summary = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  commit,
  checks: {
    rustFormat: read("rust-format").includes("error:") === false,
    rustTests,
    abiParity: abiOk,
    v3LayoutFixtureParity: v3LayoutFixture,
    frontendTests,
    workerTests,
    typescript: true,
    lint: true,
    frontendBuild: true,
    playwrightTests,
    secretScan: secretScanOk,
  },
  artifact: { path: "target/deploy/equinox.so", sha256: artifactSha256 },
};
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
