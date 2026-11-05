#!/usr/bin/env node
// @finchtech.ai/foga is an alias of @finchip.ai/foga: this launcher runs that package's CLI, installed as the
// dependency pinned in package.json, with the arguments it was given. There is one program; this is a second name for it.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageJson = require.resolve("@finchip.ai/foga/package.json");
await import(pathToFileURL(join(dirname(packageJson), "bin", "foga.js")).href);
