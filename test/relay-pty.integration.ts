import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { attachRelayChannel, relaySocketChannel } from "@pocketjs/framework/relay/wire";
import { decodeFrame, type RelayDecodedFrame } from "@pocketjs/framework/relay/frame";
import { createTermChannel } from "../app/offload.ts";
import { createTermRelayChannel } from "../app/relay.ts";
import type { TermChannel, TermChannelEvent } from "../app/channel.ts";
import { TERM_DEVICE_REPLICA, TERM_RELAY, validateFont3 } from "../shared/relay.ts";
import { TERM_APP, TERM_PROTO, type ClientLine, type HostLine, type Run } from "../shared/protocol.ts";
import { FrameParser, WIRE_MSG, encodeFrame, encodeHelloAck } from "../host/wire.ts";
import { decodeHistoryRow, type HistoryBatchReply } from "../shared/history.ts";

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

function spawnWorker(directory: string, transport: "relay" | "offload", key: string, runtime: "node" | "bun" = "node") {
  const worker = fork(fileURLToPath(new URL("../host/terminal-worker.ts", import.meta.url)),
    ["--port", "0", "--no-mirror", "--no-beacon", "--no-login", "--shell", "/bin/sh", "--cwd", directory], {
      execPath: runtime, execArgv: runtime === "node" ? ["--experimental-transform-types"] : [],
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

async function connectRelay(directory: string, key: string, running = spawnWorker(directory, "relay", key), replica = "pty-parity") {
  await running.broker; const port = await running.relayPort!;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const value = connect(port, "127.0.0.1", () => resolve(value)); value.once("error", reject);
  });
  const wire = relaySocketChannel(socket, { id: "companion", grants: ["term"] });
  let first = true;
  const sent: RelayDecodedFrame[] = [];
  const channel = createTermRelayChannel({ replica, transport: { peer: wire.peer, trySend(bytes) {
    const decoded = decodeFrame(bytes); assert(decoded.ok); sent.push(decoded.frame);
    if (!first) return wire.send(bytes) ? "accepted" : "busy";
    first = false; const authenticated = new Uint8Array(64 + bytes.length); authenticated.set(Buffer.from(key)); authenticated.set(bytes, 64);
    return wire.send(authenticated) ? "accepted" : "busy";
  } } });
  const attached = attachRelayChannel({ handleRecord: bytes => channel.handleRecord(bytes), handleDisconnect: reason => channel.disconnect(reason),
    close: () => channel.dispose?.(), flush: () => channel.step() }, wire, { maxWireBytes: TERM_RELAY.fontBytes });
  channel.connect();
  return { worker: running.worker, channel, events: [] as TermChannelEvent[], log: running.log, sent, socket,
    disconnect() { attached.close(); socket.destroy(); }, async close() {
    attached.close(); socket.destroy(); running.worker.kill();
    if (running.worker.exitCode === null && running.worker.signalCode === null) await once(running.worker, "exit");
  } };
}

async function settle(client: RunningClient, predicate: (image: GridImage) => boolean, image: GridImage): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate(image)) {
    assert.equal(client.worker.exitCode, null, `terminal worker exited: ${client.log()}`);
    assert.equal(client.worker.signalCode, null, `terminal worker killed: ${client.log()}`);
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

// Real wall time: the production PKNT timer ticks every 2 s and drops silent
// sockets after 10 s. Keep output flowing beyond the next tick after 10 s.
const TIMER_OBSERVATION_MS = 13_000;

async function connectPknt(port: number, answerPing: boolean) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  const parser = new FrameParser();
  let prefix = Buffer.alloc(0), acknowledged = false, pings = 0, closedAt = 0;
  const connectedAt = Date.now();
  let error: Error | undefined;
  socket.on("error", cause => { error = cause; });
  socket.on("close", () => { closedAt = Date.now(); });
  socket.on("data", (chunk: Buffer) => {
    if (!acknowledged) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 8) return;
      assert.deepEqual(prefix.subarray(0, 8), Buffer.from(encodeHelloAck()));
      acknowledged = true; chunk = prefix.subarray(8);
    }
    for (const frame of parser.push(chunk)) if (frame.type === WIRE_MSG.ping) {
      pings++;
      if (answerPing) socket.write(encodeFrame(WIRE_MSG.pong, frame.payload));
    }
  });
  const app = Buffer.from(TERM_APP), hello = Buffer.alloc(7 + app.length);
  hello.set(encodeHelloAck().subarray(0, 5)); hello[6] = app.length; hello.set(app, 7);
  socket.write(hello);
  return { socket, connectedAt, get acknowledged() { return acknowledged; }, get pings() { return pings; }, get closedAt() { return closedAt; }, get error() { return error; } };
}

// The daemon uses Node. An explicit runtime selects the same acceptance
// test for compatibility checks; a failing Bun PTY is not skipped or mocked.
const workerRuntime = process.env.POCKET_TERM_WORKER_RUNTIME ?? "node";
if (workerRuntime !== "node" && workerRuntime !== "bun") throw new Error("Expected POCKET_TERM_WORKER_RUNTIME=node or bun");
for (const runtime of [workerRuntime] as const) {
  test(`real ${runtime} relay worker survives PKNT ping and silence timers`, { timeout: 35000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), `pocket-term-timers-${runtime}-`)), key = randomBytes(32).toString("hex");
    const running = spawnWorker(root, "relay", key, runtime);
    const startedAt = Date.now();
    let exit: { code: number | null; signal: string | null; elapsedMs: number } | undefined;
    running.worker.once("exit", (code, signal) => { exit = { code, signal, elapsedMs: Date.now() - startedAt }; });
    let relay: Awaited<ReturnType<typeof connectRelay>> | undefined;
    let live: Awaited<ReturnType<typeof connectPknt>> | undefined, silent: typeof live;
    try {
      relay = await connectRelay(root, key, running, TERM_DEVICE_REPLICA);
      let image = new GridImage();
      await settle(relay, () => relay!.channel.open(), image);
      assert(relay.channel.send({ t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10], history: 1 }));
      await settle(relay, value => value.generation > 0 && !relay!.channel.inputPending!(), image);
      const openedAt = Date.now();
      console.log(`TIMER ${runtime}: handheld OPEN and initial grid received`);
      const pkntPort = Number(running.log().match(/PKNT listener on tcp\/(\d+)/)?.[1]);
      assert(pkntPort > 0, running.log());
      live = await connectPknt(pkntPort, true); silent = await connectPknt(pkntPort, false);
      // The shell stays interactive after the loop. A file proves execution,
      // while ANSI output changes a grid row at each real-time interval.
      assert(relay.channel.send({ t: "ch", s: "PS1=''; stty -echo; i=0; while [ $i -lt 15 ]; do printf '\\033[HTICK_%02d\\n' \"$i\"; i=$((i+1)); sleep 1; done; printf LOOP_DONE > loop-done\r" }));
      let lastTick = -1; const received: { tick: number; elapsedMs: number }[] = [];
      while (Date.now() - openedAt < TIMER_OBSERVATION_MS) {
        const until = Date.now() + 50;
        await settle(relay, () => Date.now() >= until, image);
        const tick = Number(image.bytes().toString().match(/TICK_(\d+)/)?.[1] ?? -1);
        if (tick > lastTick) { lastTick = tick; received.push({ tick, elapsedMs: Date.now() - openedAt }); }
      }
      assert(received.length >= 10, JSON.stringify({ received, grid: image.bytes().toString(), status: relay.channel.status?.(), events: relay.events, log: running.log() }));
      assert(received.some(value => value.tick >= 12 && value.elapsedMs > 12_000), JSON.stringify(received));
      assert(live.acknowledged && silent.acknowledged);
      assert(live.pings >= 6 && !live.socket.destroyed, `live PKNT pings=${live.pings}`);
      assert(silent.pings >= 4 && silent.closedAt > 0, `silent PKNT pings=${silent.pings}, closed=${silent.closedAt}`);
      assert(silent.closedAt - silent.connectedAt >= 10_000);
      assert.equal(live.error, undefined);
      assert.equal(exit, undefined, running.log());

      await settle(relay, () => existsSync(join(root, "loop-done")), image);
      // Resubmit the same opEpoch/opId through a new relay REQUEST, after the
      // timer boundary. PTY side effects must occur once.
      const command = "printf x >> once; printf '\\033[2J\\033[HINPUT_OK\\n'\r";
      assert(relay.channel.send({ t: "ch", s: command }));
      await settle(relay, value => value.bytes().includes("INPUT_OK") && !relay!.channel.inputPending!(), image);
      const sent = relay.sent.filter(frame => frame.metadata.op === "x.term.ch").at(-1)!;
      const duplicate = relay.channel.endpoint.request(sent.stream, "x.term.ch", sent.metadata.args, {
        opEpoch: String(sent.metadata.opEpoch), opId: String(sent.metadata.opId),
      });
      let duplicateDone = false; void duplicate.then(() => { duplicateDone = true; });
      await settle(relay, () => duplicateDone, image);
      assert((await duplicate).ok);
      // Queue a shell barrier after the duplicate, so a second write cannot
      // hide behind a premature filesystem observation.
      assert(relay.channel.send({ t: "ch", s: "printf barrier > barrier; printf '\\033[2JBARRIER_OK\\n'\r" }));
      await settle(relay, () => existsSync(join(root, "barrier")), image);
      assert.equal(readFileSync(join(root, "once"), "utf8"), "x");

      assert(relay.channel.send({ t: "glyphs", one: "é", two: "中", reset: 1 }));
      await settle(relay, () => relay!.events.some(event => event.t === "font" && event.slot === 19), image);
      const firstFont = relay.events.find(event => event.t === "font" && event.slot === 19)!;
      assert(firstFont.t === "font"); validateFont3(firstFont.data, firstFont.slot);
      assert(relay.channel.send({ t: "glyphs", one: "é", two: "中文", reset: 1 }));
      await settle(relay, () => relay!.events.some(event => event.t === "font" && event.slot === 19 && event.gen > firstFont.gen), image);
      const replacement = relay.events.filter(event => event.t === "font" && event.slot === 19).at(-1)!;
      assert(replacement.t === "font"); validateFont3(replacement.data, replacement.slot);
      assert.notDeepEqual(replacement.data, firstFont.data);

      assert(relay.channel.send({ t: "ch", s: "printf '\\033[3J\\033[2J\\033[H'; i=0; while [ $i -lt 48 ]; do printf 'HISTORY_%02d 中\\n' \"$i\"; i=$((i+1)); done\r" }));
      await settle(relay, value => value.bytes().includes("HISTORY_47"), image);
      const grid = relay.events.filter(event => event.t === "grid" && event.history).at(-1)!;
      assert(grid.t === "grid" && grid.history && grid.history.end - grid.history.first >= 16);
      const rows = Array.from({ length: 16 }, (_, i) => grid.history!.first + i);
      let history: HistoryBatchReply | undefined, historyError = "";
      relay.channel.historyIO!.request("term.history.batch", JSON.stringify({ sid: grid.sid, epoch: grid.history.epoch, rows, offset: 0 }), result => {
        if (result.ok) history = JSON.parse(result.value); else historyError = String(result.error);
      });
      await settle(relay, () => history !== undefined || historyError.length > 0, image);
      assert.equal(historyError, ""); assert(history);
      assert.equal(history.epoch, grid.history.epoch); assert.equal(history.chunks.length, 16);
      history.chunks.forEach(([row, offset, data, more], i) => {
        assert.equal(row, rows[i]); assert.equal(offset, 0); assert.equal(more, false);
        const runs = decodeHistoryRow(data);
        assert.equal(runs[0][0], 0); assert.equal(runs[0][1], "HISTORY_" + String(i).padStart(2, "0"));
        const wide = runs.find(run => run[1] === "中"); assert(wide);
        assert.equal(wide[0], 11); assert.equal(wide[5], 2);
      });

      // A detached replica remains in the hub, with no PKNT socket. Cross a
      // complete ping tick with no sink, then reopen the same handheld.
      relay.disconnect();
      const detachedUntil = Date.now() + 2200;
      await settle(relay, () => Date.now() >= detachedUntil, image);
      relay = await connectRelay(root, key, running, TERM_DEVICE_REPLICA); image = new GridImage();
      await settle(relay, value => value.generation > 0 && value.bytes().includes("HISTORY_47"), image);
      assert(relay.channel.send({ t: "ch", s: "printf '\\033[2J\\033[HREOPEN_OK\\n'\r" }));
      await settle(relay, value => value.bytes().includes("REOPEN_OK"), image);
      relay.disconnect();
      const closedUntil = Date.now() + 100;
      await settle(relay, () => Date.now() >= closedUntil, image);
      assert.equal(exit, undefined, running.log());
      console.log(`TIMER ${runtime}: ${JSON.stringify({ elapsedMs: Date.now() - openedAt, received, livePkntPings: live.pings, silentPkntClosedMs: silent.closedAt - silent.connectedAt, duplicateEffectBytes: readFileSync(join(root, "once")).length, fontGenerations: [firstFont.gen, replacement.gen], fontBytes: [firstFont.data.length, replacement.data.length], historyRows: history.chunks.length, reconnected: true, aliveAfterClose: true })}`);
    } finally {
      const artifacts = process.env.POCKET_TERM_VALIDATION_DIR;
      if (artifacts) {
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(join(artifacts, `timer-${runtime}-worker.log`), `${running.log()}\nexit-before-cleanup=${JSON.stringify(exit ?? null)}\n`);
      }
      live?.socket.destroy(); silent?.socket.destroy(); relay?.disconnect();
      running.worker.kill();
      if (running.worker.exitCode === null && running.worker.signalCode === null) await once(running.worker, "exit");
      rmSync(root, { recursive: true, force: true });
    }
  });
}
