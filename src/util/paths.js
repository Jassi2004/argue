import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package's root folder (where package.json, bin/, skills/ and instructions/ live). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fromRoot = (...p) => join(PACKAGE_ROOT, ...p);
