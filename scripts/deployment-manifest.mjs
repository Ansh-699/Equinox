import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "config", "equinox-deployment.json");
export const DEPLOYMENT_MANIFEST = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
export const DEFAULT_PROGRAM_ID = DEPLOYMENT_MANIFEST.programId;
export const DEFAULT_MAGIC_ROUTER = DEPLOYMENT_MANIFEST.magicBlock.router;
export const DEFAULT_MAGIC_ER_RPC = DEPLOYMENT_MANIFEST.magicBlock.rpc;
export const DEFAULT_VALIDATOR = DEPLOYMENT_MANIFEST.magicBlock.validator;
