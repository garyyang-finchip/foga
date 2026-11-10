// Keep the alias packages at the main package's version: `npm run alias:sync` after a version bump, then publish each
// alias from its own folder (`cd alias/<scope> && npm publish --tag latest`). An alias depends on the exact version it
// is an alias of, so a cell that installs the alias runs the same program a cell that installs the main package runs.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const main = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dir of readdirSync(join(root, "alias"))) {
  const file = join(root, "alias", dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = main.version;
  pkg.dependencies[main.name] = main.version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name}@${pkg.version} -> ${main.name}@${main.version} (${file})`);
}
