// npm's `prepare` hook: compile the CLI when a checkout is installed as a dependency straight from git
// (`npm install github:garyyang-finchip/foga`, `npx -y github:garyyang-finchip/foga …`), where no dist/ exists yet.
// It stays out of the way everywhere else: when dist/cli.js is already there, when there is no src/ to compile (the
// Docker image installs dependencies before it copies the sources), and when TypeScript is not installed (a
// production install of the published tarball, which carries dist/ already).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, "dist", "cli.js")) || !existsSync(join(root, "src", "cli.ts"))) process.exit(0);
let tsc;
try {
  tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
} catch {
  process.exit(0);
}
console.error("foga: compiling the CLI (prepare: a checkout installed from git has no dist/ yet)");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit", cwd: root });
