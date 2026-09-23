/** Reproducible transport accounting. The benchmark test drives one terminal
 * fixture through both public clients and prints its receipt as JSON. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT } from "./paths.ts";

const result = spawnSync(
  process.execPath,
  ["test", "--conditions=browser", "--test-name-pattern", "wire cost", "test/relay.test.ts"],
  { cwd: ROOT, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
