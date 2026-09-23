// bun run 3ds [--relay | --offload] [--pocket-only] [--capture] [--cia]
// builds the console binary. Relay is the default; --offload produces the
// explicit rollback artifact.
//
// The toolchain lives in the submodule and is driven by a resolved plan: this
// script resolves pocket.json against the out-of-registry "3ds-dev" profile,
// writes the plan, and hands it to vendor/pocketjs/tools/3ds.ts with this
// repository as the project root. The build writes into the submodule's own
// dist/3ds (that is where the Rust core, QuickJS and the container's bind
// mount already are), so the artefacts are copied back here afterwards.
//
//   bun run 3ds                 -> dist/3ds/pocketterm-main.3dsx
//   bun run 3ds --offload       -> the same artifact name, with the legacy entry
//   bun run 3ds --pocket-only   -> dist/3ds/pocketterm-main.pocket (hot push)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolve3dsBuildPlan } from "../vendor/pocketjs/tools/3ds-profile.ts";
import { build3ds } from "../vendor/pocketjs/tools/3ds.ts";
import { DIST_3DS, PLAN_DIR, ROOT, VENDOR } from "./paths.ts";
import { parseTermTransportArguments, termTransportEntry } from "../shared/transport.ts";

const selected = parseTermTransportArguments(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(resolve(ROOT, "pocket.json"), "utf8"));
manifest.app.entry = termTransportEntry(selected.transport);
const plan = resolve3dsBuildPlan(manifest);

mkdirSync(PLAN_DIR, { recursive: true });
const manifestPath = resolve(PLAN_DIR, `${plan.app.output}.${selected.transport}.manifest.json`);
const planPath = resolve(PLAN_DIR, `${plan.app.output}.${selected.transport}.3ds.plan.json`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

console.log(`pocket-term: building ${selected.transport} transport`);
await build3ds([`--plan=${planPath}`, `--manifest=${manifestPath}`, `--project-root=${ROOT}`, ...selected.rest]);

mkdirSync(DIST_3DS, { recursive: true });
const pocketOnly = selected.rest.includes("--pocket-only");
const produced = [
  resolve(VENDOR, `dist/3ds/${plan.app.output}.pocket`),
  ...(!pocketOnly ? [resolve(VENDOR, `dist/3ds/${plan.app.output}.3dsx`)] : []),
  ...(selected.rest.includes("--cia") ? [resolve(VENDOR, `dist/3ds/${plan.app.output}.cia`)] : []),
].filter((path) => existsSync(path));
for (const path of produced) {
  const destination = resolve(DIST_3DS, basename(path));
  copyFileSync(path, destination);
  console.log(`pocket-term: ${destination}`);
}
