#!/usr/bin/env node
// Launcher for the published package: runs the compiled CLI.
// During development use `npm run foga -- <args>` (tsx) instead.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli.js");
if (!existsSync(dist)) {
  console.error("foga: compiled CLI not found. Run `npm run build` first, or use `npm run foga -- <args>`.");
  process.exit(1);
}
await import(dist);
