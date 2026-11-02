import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./fs.js";

/** The package version, read once from package.json (the same file the npm package ships). */
export const version: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
})();
