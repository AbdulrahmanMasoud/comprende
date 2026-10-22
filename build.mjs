// Bundles src/*.ts into self-contained files in dist/ that need nothing but
// Node: no node_modules at runtime, no install step for plugin users.
// The gate and learning scripts are also copied into the skill folder so the
// skill works on its own.
import { build } from "esbuild";
import { copyFileSync, existsSync, readFileSync, chmodSync } from "node:fs";

const gateSrc = readFileSync("src/gate.ts", "utf8");
const version = gateSrc.match(/export const GATE_VERSION = (\d+)/)?.[1];
if (!version) throw new Error("GATE_VERSION not found in src/gate.ts");
const features = gateSrc.match(/export const GATE_FEATURES = "([^"]*)"/)?.[1];
if (features === undefined) throw new Error("GATE_FEATURES not found in src/gate.ts");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
};
const header = (name) =>
  `#!/usr/bin/env node\n// Generated from src/${name}.ts by build.mjs. Edit the source, then run \`npm run build\`.\n`;

const entries = [
  // The gate must import only node: built-ins (checked below), so a repo can
  // never shadow a module it loads.
  // The version and features lines are read by other gates (status notes, and
  // whether the base branch's copy supports a feature such as the fast path).
  { name: "gate", banner: `${header("gate")}// ownership-gate-version: ${version}\n// ownership-gate-features: ${features}` },
  { name: "learning", banner: header("learning") },
  // The MCP server bundles its SDK; esbuild needs a `require` shim for the
  // CommonJS bits of its dependencies.
  {
    name: "server",
    banner: `${header("server")}import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);`,
  },
];

for (const e of entries) {
  const src = `src/${e.name}.ts`;
  if (!existsSync(src)) continue;
  const out = `dist/${e.name}.mjs`;
  await build({ ...common, entryPoints: [src], outfile: out, banner: { js: e.banner } });
  chmodSync(out, 0o755);
  if (e.name !== "server") {
    const code = readFileSync(out, "utf8");
    const bare = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith("node:") && !s.startsWith("data:text/javascript;base64,"));
    if (bare.length) throw new Error(`${out} imports non-builtin modules: ${[...new Set(bare)].join(", ")}`);
    copyFileSync(out, `skills/comprende/scripts/${e.name}.mjs`);
  }
  console.log(`built ${out}`);
}
