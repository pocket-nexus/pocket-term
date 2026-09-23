import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { attachRelayChannel, relaySocketChannel } from "@pocketjs/framework/relay/wire";
import { createTermChannel } from "../app/offload.ts";
import { createTermRelayChannel } from "../app/relay.ts";
import type { TermChannel, TermChannelEvent } from "../app/channel.ts";
import { TERM_RELAY } from "../shared/relay.ts";
import { TERM_PROTO, type ClientLine, type HostLine, type Run } from "../shared/protocol.ts";

interface WorkerReady { endpoint: string; token: string }
interface RunningClient { worker: ChildProcess; channel: TermChannel; events: TermChannelEvent[]; log: () => string; close(): Promise<void> }

class GridImage {
  generation = -1;
  sequence = -1;
  ack = 0;
  cursor: [number, number, 0 | 1] = [0, 0, 0];
  rows: Run[][] = Array.from({ length: 24 }, () => []);
  private staged = new Map<number, Run[]>();

  apply(line: Extract<HostLine, { t: "grid" }>): void {
    if (line.gen > this.generation) {
      assert.equal(line.seq, 0); assert.equal(line.full, 1);
      this.generation = line.gen; this.sequence = -1; this.staged.clear();
    }
    if (line.gen !== this.generation || line.seq <= this.sequence) return;
    assert.equal(line.seq, this.sequence + 1); this.sequence = line.seq;
    for (const [row, ...runs] of line.rows) this.staged.set(row, runs);
    if (line.more) return;
    if (line.full) this.rows = Array.from({ length: 24 }, () => []);
    for (const [row, runs] of this.staged) this.rows[row] = runs;
    this.staged.clear();
    if (line.cur) this.cursor = line.cur;
    if (line.ack !== undefined) this.ack = line.ack;
  }

  bytes(): Buffer { return Buffer.from(JSON.stringify({ rows: this.rows, cursor: this.cursor })); }
}

function spawnWorker(directory: string, transport: "relay" | "offload", key: string) {
  const worker = fork(fileURLToPath(new URL("../host/terminal-worker.ts", import.meta.url)),
    ["--port", "0", "--no-mirror", "--no-beacon", "--no-login", "--shell", "/bin/sh", "--cwd", directory], {
      env: { ...process.env, POCKET_TERM_TRANSPORT: transport, ...(transport === "relay" ? {
        POCKET_TERM_RELAY_KEY: key, POCKET_TERM_RELAY_PORT: "0", POCKET_TERM_RELAY_JOURNAL: join(directory, "relay-operations.json"),
      } : {}) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  let output = ""; worker.stdout!.on("data", chunk => output += chunk); worker.stderr!.on("data", chunk => output += chunk);
  const broker = new Promise<WorkerReady>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal worker did not start: ${output}`)), 5000);
    const listener = (message: unknown) => {
      const value = message as Partial<WorkerReady> & { ready?: boolean };
      if (value.ready && value.endpoint && value.token) { clearTimeout(timer); worker.off("message", listener); resolve(value as WorkerReady); }
    };
    worker.on("message", listener);
  });
  let relayPort: Promise<number> | undefined;
  if (transport === "relay") relayPort = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay authority did not start: ${output}`)), 5000);
    const listener = (message: unknown) => {
      const value = message as { relayReady?: boolean; port?: number };
      if (value.relayReady && Number.isSafeInteger(value.port)) { clearTimeout(timer); worker.off("message", listener); resolve(value.port!); }
    };
    worker.on("message", listener);
  });
  return { worker, broker, relayPort, log: () => output };
}

async function connectOffload(directory: string, key: string): Promise<RunningClient> {
  const running = spawnWorker(directory, "offload", key), ready = await running.broker;
  let ticket = 0, connected = true;
  const abort = new Map<number, AbortController>();
  const channel = createTermChannel({
    connected: () => connected, session: () => 1, cancel(id) { abort.get(id)?.abort(); abort.delete(id); },
    request(method, payload, complete) {
      const id = ++ticket, controller = new AbortController(); abort.set(id, controller);
      const path = method === "term.input" ? "/input" : method === "term.history.batch" ? "/history-batch" : "/exchange";
      void fetch(new URL(path, ready.endpoint), { method: "POST", headers: { authorization: `Bearer ${ready.token}` }, body: payload, signal: controller.signal })
        .then(async response => { const value = await response.text(); complete(response.ok ? { ok: true, value } : { ok: false, error: value }); })
        .catch(error => { if (!controller.signal.aborted) complete({ ok: false, error: String(error) }); })
        .finally(() => abort.delete(id));
      return id;
    },
  }, "pty-parity");
  return { worker: running.worker, channel, events: [], log: running.log, async close() {
    connected = false; channel.dispose?.(); running.worker.kill();
    if (running.worker.exitCode === null && running.worker.signalCode === null) await once(running.worker, "exit");
  } };
}

async function connectRelay(directory: string, key: string): Promise<RunningClient> {
  const running = spawnWorker(directory, "relay", key);
  await running.broker; const port = await running.relayPort!;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const value = connect(port, "127.0.0.1", () => resolve(value)); value.once("error", reject);
  });
  const wire = relaySocketChannel(socket, { id: "companion", grants: ["term"] });
  let first = true;
  const channel = createTermRelayChannel({ replica: "pty-parity", transport: { peer: wire.peer, trySend(bytes) {
    if (!first) return wire.send(bytes) ? "accepted" : "busy";
    first = false; const authenticated = new Uint8Array(64 + bytes.length); authenticated.set(Buffer.from(key)); authenticated.set(bytes, 64);
    return wire.send(authenticated) ? "accepted" : "busy";
  } }, pingIntervalMs: 1e9, stallMs: 1e9 });
  const attached = attachRelayChannel({ handleRecord: bytes => channel.handleRecord(bytes), handleDisconnect: reason => channel.disconnect(reason),
    close: () => channel.dispose?.(), flush: () => channel.step() }, wire, { maxWireBytes: TERM_RELAY.fontBytes });
  channel.connect();
  return { worker: running.worker, channel, events: [], log: running.log, async close() {
    attached.close(); socket.destroy(); running.worker.kill();
    if (running.worker.exitCode === null && running.worker.signalCode === null) await once(running.worker, "exit");
  } };
}

async function settle(client: RunningClient, predicate: (image: GridImage) => boolean, image: GridImage): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate(image)) {
    if (Date.now() >= deadline) throw new Error(`terminal parity timeout: ${client.channel.status?.() ?? ""}\ngrid=${image.bytes().toString()}\n${client.log()}`);
    client.channel.step?.();
    for (const event of client.channel.poll()) { client.events.push(event); if (event.t === "grid") image.apply(event); }
    await delay(5);
  }
}

async function exercise(client: RunningClient): Promise<GridImage> {
  const image = new GridImage(), send = async (line: ClientLine) => {
    assert(client.channel.send(line));
    await settle(client, () => !client.channel.inputPending?.(), image);
  };
  await settle(client, () => client.channel.open(), image);
  await send({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10], history: 1 });
  await settle(client, value => value.generation > 0, image);
  await send({ t: "ch", s: "PS1=''; printf '\\033[2J\\033[H\\033[31mRED\\033[0m plain\nwide 中 →\n'" + "\r" });
  await settle(client, value => value.rows.some(row => row.some(run => run[1].includes("wide"))), image);
  await send({ t: "paste", s: "printf 'PASTE_OK\n'\n", phase: "single" });
  await settle(client, value => value.rows.some(row => row.some(run => run[1].includes("PASTE_OK"))), image);
  await send({ t: "glyphs", one: "é", two: "中", reset: 1 });
  const before = image.generation; await send({ t: "resync" });
  await settle(client, value => value.generation > before && value.ack >= 5, image);
  return image;
}

test("real PTY output and input produce byte-identical offload and Relay cell grids", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-term-relay-pty-")), key = randomBytes(32).toString("hex");
  let offload: RunningClient | undefined, relay: RunningClient | undefined;
  try {
    offload = await connectOffload(root, key);
    relay = await connectRelay(root, key);
    const legacyImage = await exercise(offload), relayImage = await exercise(relay);
    const legacyBytes = legacyImage.bytes(), relayBytes = relayImage.bytes();
    assert.deepEqual(relayBytes, legacyBytes);
    assert.match(relayBytes.toString(), /RED/); assert.match(relayBytes.toString(), /PASTE_OK/); assert.match(relayBytes.toString(), /中/);
    console.log(`PTY grid parity: bytes=${relayBytes.length} sha256=${createHash("sha256").update(relayBytes).digest("hex")}`);
  } finally {
    await relay?.close(); await offload?.close(); rmSync(root, { recursive: true, force: true });
  }
});
