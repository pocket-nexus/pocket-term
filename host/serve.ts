/** Supervisor: native PTYs run under Node; PocketJS's provider uses Bun
 * workers. The durable terminal process outlives every device connection. */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTermTransportArguments } from "../shared/transport.ts";

const selected = parseTermTransportArguments(process.argv.slice(2));
const args = selected.rest, terminalArgs: string[] = [];
let address = "", keyPath = ".pocket/offload.key";
const transport = selected.transport;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--device" || args[i] === "--unicast") {
    if (!args[i + 1]) throw new Error(`Expected an address after ${args[i]}`);
    address = args[++i]!;
  } else if (args[i] === "--key") {
    if (!args[i + 1]) throw new Error("Expected a path after --key");
    keyPath = args[++i]!;
  }
  else terminalArgs.push(args[i]);
}
if (transport === "offload" && !address) throw new Error("The offload transport requires --device <console-ip>");
if (transport === "relay" && address) throw new Error("--device and --unicast apply only to --offload");
const key = readFileSync(resolve(keyPath), "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Expected a paired companion key; run bun run pair --host <ip>");
console.log(`[term] ${transport} transport${transport === "offload" && address ? ` -> ${address}` : ""}`);
const worker = fork(fileURLToPath(new URL("./terminal-worker.ts", import.meta.url)), terminalArgs, {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  env: { ...process.env, POCKET_TERM_TRANSPORT: transport, ...(transport === "relay" && key ? { POCKET_TERM_RELAY_KEY: key } : {}) },
});
let provider: ChildProcess | undefined;
let stopping = false;
worker.on("message", (message: any) => {
  if (message.ready && address && transport === "offload") {
    provider = spawn("bun", [fileURLToPath(new URL("./provider.ts", import.meta.url))], {
      stdio: "inherit", env: { ...process.env, POCKET_TERM_PROVIDER: JSON.stringify({ address, key, ...message }) },
    });
    provider.on("error", error => { console.error(error.message); stop(1); });
    provider.on("exit", code => { if (!stopping) stop(code || 1); });
  }
});
function stop(code: number) {
  if (stopping) return;
  stopping = true; provider?.kill(); worker.kill();
  process.exitCode = code;
}
worker.on("error", error => { console.error(error.message); stop(1); });
worker.on("exit", code => stop(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
