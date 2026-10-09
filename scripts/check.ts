import { spawnSync } from "node:child_process";
import { ROOT } from "./paths.ts";
import { parseTermTransportArguments } from "../shared/transport.ts";

const selected = parseTermTransportArguments(process.argv.slice(2));
if (selected.rest.length) throw new Error(`Unknown check argument: ${selected.rest[0]}`);
console.log(`pocket-term: checking ${selected.transport} transport (the suite exercises relay and offload parity)`);
for (const args of [["run", "typecheck"], ["run", "test"]]) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, POCKET_TERM_TEST_TRANSPORT: selected.transport } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
