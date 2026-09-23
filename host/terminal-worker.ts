/** Terminal worker: persistent session registry, bounded replica views,
 * authenticated local capabilities and loopback desktop mirror transport.
 * The supervisor owns process lifetime; device connections own no PTYs. */

import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Mailbox } from "./exchange.ts";
import { LIMITS, type ExchangeRequest } from "../shared/exchange.ts";
import { HISTORY, type HistoryRequest, type HistoryBatchRequest } from "../shared/history.ts";
import { historyBatchReply, validateHistoryBatch } from "./history-batch.ts";
import { hostname } from "node:os";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Session } from "./session.ts";
import {
  LINE_BUDGET,
  TERM_APP,
  TERM_PROTO,
  type ClientLine,
  type Cursor,
  type HostLine,
  type Role,
  type RowUpdate,
  type Run,
  type SessionInfo,
  validateClientLine,
} from "../shared/protocol.ts";
import { chunkRows, resolveCell, rowKey, rowRuns, type Cell } from "./grid.ts";
import { DynamicAtlasSet, isBakedCodepoint } from "./glyphs.ts";
import { encodeKey } from "./keys.ts";
import { serveTermRelay, type TermRelayReplica, type TermRelaySink } from "./relay-host.ts";
import { TermOperationJournal } from "./relay-journal.ts";
import {
  FrameParser,
  WIRE_MSG,
  WIRE_PORT,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
/** The desktop host binary, which is also the `linux-app` one. */
const MIRROR_BIN = join(ROOT, "vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host");
const MIRROR_APP = "pocketterm-mirror-main";

const options = {
  port: WIRE_PORT,
  name: hostname().replace(/\.local$/, ""),
  shell: process.env.SHELL ?? "/bin/zsh",
  cwd: process.env.HOME ?? process.cwd(),
  login: true,
  trace: false,
  /** Open a desktop window per session. */
  mirror: true,
};

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") options.port = Number(argv[++i]);
    else if (a === "--name") options.name = argv[++i];
    else if (a === "--shell") options.shell = argv[++i];
    else if (a === "--cwd") options.cwd = argv[++i];
    else if (a === "--trace") options.trace = true;
    else if (a === "--no-login") options.login = false;
    else if (a === "--no-beacon") {} // accepted by older launch scripts
    else if (a === "--no-mirror") options.mirror = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
}

// Bun's installer drops the executable bit on prebuilt binaries; node-pty's
// posix_spawn of its helper then fails with a bare "posix_spawnp failed".
for (const helper of [
  join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules/node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  ),
]) {
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}

// ---------------------------------------------------------------------------
// sessions — PTY + authoritative terminal core
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// connections — one attached replica each
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 2000;
const SILENCE_TIMEOUT_MS = 10_000;
/** Coalescing delay after a session produces output. A terminal's echo is a
 *  round trip through here, so this sits directly in the gap between a
 *  keystroke and the character appearing: it is a batching window, not a
 *  polling rate. A byte-at-a-time echo pays 2 ms; a screenful of output
 *  still collapses into one pass. */
const FLUSH_COALESCE_MS = 2;
/** Backstop for the changes no PTY byte announces — a scrollback scrub, a
 *  cursor that moved because a replica attached. */
const FLUSH_IDLE_MS = 100;

/** Keep one atlas piece within a typical offload reply so changed rows can
 * take the next output turn instead of waiting through a large atlas line. */
const ATLAS_CHUNK = 1536;

/** Transport ownership is independent of the device/mirror view role. */
type ConnTransport =
  | { kind: "pknt"; socket: Socket }
  | { kind: "offload"; mailbox: Mailbox }
  | { kind: "relay"; sink?: TermRelaySink };

class Conn {
  readonly transport: ConnTransport;
  readonly parser = new FrameParser();
  hello: Uint8Array | null = new Uint8Array(0);
  role: Role = "device";
  mirrorSid?: number;
  cols = 80;
  rows = 24;
  cell: [number, number] = [5, 10];
  attachedSid = -1;
  /** Atlas generation this replica holds per slot, and the chunks still owed
   *  to it for the slot in flight. One chunk goes out per flush tick: the
   *  device's line queue is 32 KiB and drops its oldest entries when full,
   *  so a whole atlas dumped at once would take the grid updates with it. */
  atlasSent = new Map<number, number>();
  atlasSlot = 0;
  atlasGen = -1;
  atlasQueue: string[] = [];
  atlasSeq = 0;
  gen = 0;
  seq = 0;
  scrollback = 0;
  localHistory = false;
  historyGlyphs: [number, number][] = [];
  pendingGlyphs?: [number, number][];
  rowCache: string[] = [];
  lastCursor = "";
  lastRx = Date.now();
  sawClientHello = false;
  paste?: { sid: number; text: string; at: number };
  relayAck = 0;

  constructor(transport: ConnTransport) {
    this.transport = transport;
  }

  get mailbox(): Mailbox | undefined {
    return this.transport.kind === "offload" ? this.transport.mailbox : undefined;
  }

  get relaySink(): TermRelaySink | undefined {
    return this.transport.kind === "relay" ? this.transport.sink : undefined;
  }

  set relaySink(sink: TermRelaySink | undefined) {
    if (this.transport.kind === "relay") this.transport.sink = sink;
  }

  sendLine(line: HostLine) {
    const transport = this.transport;
    if (transport.kind === "relay") { transport.sink?.line(line); return; }
    if (transport.kind === "offload") { transport.mailbox.push(line); return; }
    if (transport.socket.writableLength > LIMITS.outputChars) { transport.socket.destroy(); return; }
    transport.socket.write(encodeCtrl(JSON.stringify(line)));
  }

  /** Emit rows (+cursor/scrollback trailer) as ordered, chunked grid lines. */
  sendGrid(updates: RowUpdate[], cursor: Cursor, full: boolean) {
    const chunks = chunkRows(updates, LINE_BUDGET);
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      this.sendLine({
        t: "grid",
        sid: this.attachedSid,
        gen: this.gen,
        seq: this.seq++,
        ...(full ? { full: 1 as const } : {}),
        ...(last ? {} : { more: 1 as const }),
        rows: chunks[i],
        ...(last ? { cur: cursor, ack: this.mailbox?.ack ?? this.relayAck, sb: this.scrollback, history: hub.sessions.get(this.attachedSid)?.history.manifest() } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

class Hub {
  readonly sessions = new Map<number, Session>();
  readonly conns = new Set<Conn>();
  private nextSid = 1;
  /** Set by the mirror supervisor; called once per new session. */
  onSessionCreated: ((sid: number) => void) | null = null;

  create(cols: number, rows: number): Session {
    if (this.sessions.size >= LIMITS.sessions) throw new Error("Session limit reached (32)");
    const session = new Session(this.nextSid++, cols, rows, options, {
      output: scheduleFlush, titles: () => this.sessionsChanged(), exit: sid => this.sessionExited(sid),
    });
    this.sessions.set(session.sid, session);
    console.log(`[term] session #${session.sid} started: pid ${session.pty.pid}, ${cols}x${rows}`);
    this.sessionsChanged();
    // A replica left with nothing attached — the empty state after the last
    // session closed — shows the first session that appears, whoever opened
    // it. Without this it would sit at the empty state while sessions exist,
    // which is the empty state lying. Mirrors are bound through the pending
    // listener instead and are left alone here.
    for (const conn of this.conns) {
      if (conn.role === "device" && conn.sawClientHello && conn.attachedSid < 0) {
        attach(conn, session.sid);
      }
    }
    if (this.onSessionCreated) {
      this.onSessionCreated(session.sid);
    }
    return session;
  }

  kill(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  sessionExited(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    closeMirror(sid);
    for (const conn of this.conns) {
      if (conn.sawClientHello) conn.sendLine({ t: "exit", sid });
    }
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  private reattachOrphans(gone: number) {
    for (const conn of this.conns) {
      if (conn.attachedSid !== gone) continue;
      if (conn.role === "mirror") {
        // A mirror exists to show one session. When that session is over so
        // is the window: it is closed rather than pointed at someone else's
        // shell.
        if (conn.transport.kind === "pknt") conn.transport.socket.destroy();
        this.conns.delete(conn);
        continue;
      }
      const fallback = [...this.sessions.values()].at(-1);
      if (fallback === undefined) {
        // Closing the last session leaves the replica with nothing attached,
        // not with a shell it did not ask for. Opening one is a decision,
        // and the operator just made the opposite one.
        conn.attachedSid = -1;
        conn.rowCache = [];
        conn.lastCursor = "";
        continue;
      }
      attach(conn, fallback.sid);
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ sid: s.sid, title: s.title }));
  }

  sessionsChanged() {
    for (const conn of this.conns) {
      if (conn.sawClientHello) {
        conn.sendLine({ t: "sessions", list: this.list(), active: conn.attachedSid });
      }
    }
  }
}

const hub = new Hub();

// ---------------------------------------------------------------------------
// the replica view: serialize, diff, flush
// ---------------------------------------------------------------------------

/** Codepoints the device cannot draw from its baked atlas, noted as the grid
 *  is serialized so the next bake covers exactly what is on screen. */
const atlas = new DynamicAtlasSet();

/** Classify a resolved cell against the device's glyph coverage: baked text
 *  passes through, a character some face in the chain can draw is routed to
 *  that face's slot, and one nobody can draw becomes a placeholder of the
 *  same column width — an unrenderable glyph must not also shift the rest of
 *  the row, which is what dropping it or leaving it to a missing atlas would
 *  do. */
const uncovered = new Set<number>();

function classify(cell: Cell, want = true): void {
  if (cell.width === 0 || cell.ch === "" || cell.ch === " ") return;
  const cp = cell.ch.codePointAt(0);
  if (cp === undefined || isBakedCodepoint(cp)) return;
  const columns = cell.width === 2 ? 2 : 1;
  const slot = atlas.slotFor(cp, columns);
  if (slot >= 0) {
    if (want) atlas.want(cp, columns, slot);
    cell.slot = slot;
    return;
  }
  // A placeholder is the last resort, and the operator should be able to
  // find out which character it stood for rather than guess from a "?".
  if (!uncovered.has(cp)) {
    uncovered.add(cp);
    console.log(
      `[term] no face draws U+${cp.toString(16).toUpperCase().padStart(4, "0")} ` +
        `(${cell.ch}) — showing a placeholder`,
    );
  }
  cell.ch = "?".repeat(columns);
}

/** Resolve the connection's visible window of the session buffer to runs. */
function viewRows(session: Session, conn: Conn): Run[][] {
  const core = session.core;
  const rows: Run[][] = [];
  if (core === null) {
    for (let y = 0; y < conn.rows; y += 1) rows.push([]);
    return rows;
  }
  // Scrolled back, the top of the view comes out of history: the core
  // indexes that directly, oldest line first, so the offset is arithmetic on
  // its own count rather than on a viewport's base row.
  const history = core.getScrollbackCount();
  const back = Math.max(0, Math.min(history, conn.scrollback));
  for (let y = 0; y < conn.rows; y += 1) {
    const fromHistory = y < back;
    const offset = history - back + y;
    const cells: Cell[] = [];
    for (let x = 0; x < conn.cols; x += 1) {
      const cell = fromHistory ? core.getScrollbackCell(history - 1 - offset, x) : core.getCell(y - back, x);
      const resolved = resolveCell(cell);
      classify(resolved);
      cells.push(resolved);
    }
    rows.push(rowRuns(cells));
  }
  return rows;
}

/** Re-bake when the screen has shown codepoints the current atlas lacks. The
 *  bake is debounced: a session that dumps a page of Chinese should cost one
 *  bake, not one per row. */
let atlasDebounce = 0;
function pumpAtlasBake(): void {
  if (!atlas.dirty) {
    atlasDebounce = 0;
    return;
  }
  atlasDebounce += 1;
  if (atlasDebounce < 8) return; // ~250 ms at the flush interval
  atlasDebounce = 0;
  const conn = [...hub.conns].find((c) => c.sawClientHello);
  const [cellW, cellH] = conn?.cell ?? [5, 10];
  for (const baked of atlas.bake(cellW, cellH)) {
    console.log(
      `[term] baked ${baked.glyphCount} glyphs at ${baked.px}px into slot ${baked.slot} ` +
        `(${(baked.bytes.length / 1024).toFixed(1)} KiB)`,
    );
  }
}

/** Hand one atlas chunk to a replica per tick. Every face in the chain is
 *  delivered, one slot at a time. */
function pumpAtlasSend(conn: Conn): void {
  if (!conn.sawClientHello) return;
  if (conn.relaySink) {
    for (const baked of atlas.current()) if (conn.atlasSent.get(baked.slot) !== baked.gen) {
      conn.atlasSent.set(baked.slot, baked.gen); conn.relaySink.font(baked.slot, baked.gen);
    }
    return;
  }
  if (conn.atlasQueue.length === 0) {
    for (const baked of atlas.current()) {
      if (conn.atlasSent.get(baked.slot) === baked.gen) continue;
      conn.atlasSent.set(baked.slot, baked.gen);
      conn.atlasSlot = baked.slot;
      conn.atlasGen = baked.gen;
      conn.atlasSeq = 0;
      const b64 = Buffer.from(baked.bytes).toString("base64");
      for (let at = 0; at < b64.length; at += ATLAS_CHUNK) {
        conn.atlasQueue.push(b64.slice(at, at + ATLAS_CHUNK));
      }
      break; // one atlas at a time; the next tick starts the next
    }
  }
  const chunk = conn.atlasQueue.shift();
  if (chunk === undefined) return;
  conn.sendLine({
    t: "atlas",
    slot: conn.atlasSlot,
    gen: conn.atlasGen,
    seq: conn.atlasSeq++,
    ...(conn.atlasQueue.length > 0 ? { more: 1 as const } : {}),
    b64: chunk,
  });
}

function cursorFor(session: Session, conn: Conn): Cursor {
  const cursor = session.core?.getCursor();
  if (cursor === undefined) return [0, 0, 0];
  const visible = conn.scrollback === 0 && cursor.visible;
  return [cursor.col, cursor.row, visible ? 1 : 0];
}

/** Full snapshot: a new gen, every row sent (blank rows included). */
function snapshot(conn: Conn) {
  const session = hub.sessions.get(conn.attachedSid);
  if (!session) return;
  conn.gen += 1;
  conn.seq = 0;
  const rows = viewRows(session, conn);
  conn.rowCache = rows.map(rowKey);
  const cursor = cursorFor(session, conn);
  conn.lastCursor = JSON.stringify([cursor, conn.scrollback, session.history.manifest()]);
  const updates: RowUpdate[] = rows.map((runs, y) => [y, ...runs]);
  conn.sendGrid(updates, cursor, true);
}

function flush(conn: Conn) {
  if (conn.mailbox?.busy) return;
  const session = hub.sessions.get(conn.attachedSid);
  if (!session || !conn.sawClientHello) return;
  const rows = viewRows(session, conn);
  const updates: RowUpdate[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const key = rowKey(rows[y]);
    if (conn.rowCache[y] !== key) {
      conn.rowCache[y] = key;
      updates.push([y, ...rows[y]]);
    }
  }
  const cursor = cursorFor(session, conn);
  const cursorKey = JSON.stringify([cursor, conn.scrollback, session.history.manifest()]);
  if (updates.length === 0 && cursorKey === conn.lastCursor) { pumpAtlasSend(conn); return; }
  conn.lastCursor = cursorKey;
  conn.sendGrid(updates, cursor, false);
}

function attach(conn: Conn, sid: number) {
  if (!hub.sessions.has(sid)) return;
  conn.attachedSid = sid;
  if (options.trace) console.log(`[term] ${conn.role} attached session #${sid}`);
  conn.scrollback = 0;
  conn.historyGlyphs = [];
  conn.pendingGlyphs = undefined;
  conn.sendLine({ t: "sessions", list: hub.list(), active: sid });
  snapshot(conn);
}

// ---------------------------------------------------------------------------
// client line handling
// ---------------------------------------------------------------------------

function handleLine(conn: Conn, line: ClientLine) {
  // A mirror types into its own session, and nothing else: the window exists
  // for one session, so it may not re-point itself at another, open one, or
  // close one. That binding is enforced here rather than trusted to the
  // window's guest.
  if (conn.role === "mirror" && (line.t === "attach" || line.t === "new" || line.t === "kill")) {
    return;
  }
  validateClientLine(line);
  if (line.t !== "hello" && !conn.sawClientHello) throw new Error("Hello required");
  if (options.trace) console.log(`[term] command ${line.t}, session #${conn.attachedSid}`);
  switch (line.t) {
    case "hello": {
      if (line.proto !== TERM_PROTO) throw new Error("Terminal protocol mismatch");
      conn.role = conn.mirrorSid !== undefined ? "mirror" : line.role ?? "device";
      conn.localHistory = conn.role === "device" && line.history === 1;
      conn.cols = 80; conn.rows = 24; conn.cell = [5, 10];
      conn.sawClientHello = true;
      // A hello means a replica that has loaded nothing yet, which is not the
      // same as a new socket: the console's transport is native and survives
      // a guest reload, so the fresh guest arrives on the connection that
      // already had an atlas. Re-send it or its CJK renders as blanks.
      conn.atlasSent.clear();
      conn.atlasGen = -1;
      conn.atlasQueue = [];
      conn.atlasSeq = 0;

      if (conn.role === "mirror") {
        // A mirror shows one session and changes nothing about it: it takes
        // the session it was opened for, renders whatever size that session
        // already is, and never resizes a PTY.
        const sid = conn.mirrorSid ?? line.want;
        const session = sid === undefined ? undefined : hub.sessions.get(sid);
        if (!session) {
          if (conn.transport.kind === "pknt") conn.transport.socket.destroy();
          hub.conns.delete(conn);
          return;
        }
        conn.cols = session.cols;
        conn.rows = session.rows;
        conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name, sid: session.sid });
        attach(conn, session.sid);
        break;
      }

      conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name });
      // Every terminal uses the fixed primary geometry: every session tracks the driving replica's grid
      // (the tmux attach model, one window size at a time). Other replicas
      // that were sized differently get a fresh snapshot at the new size.
      for (const session of hub.sessions.values()) session.resize(conn.cols, conn.rows);
      for (const other of hub.conns) {
        if (other === conn || !other.sawClientHello) continue;
        if (other.cols !== conn.cols || other.rows !== conn.rows) {
          other.cols = conn.cols;
          other.rows = conn.rows;
          snapshot(other);
        }
      }
      // A reconnecting console names the session it was on, so the window it
      // comes back to is the one it left rather than whichever is newest.
      const wanted = line.want !== undefined ? hub.sessions.get(line.want) : undefined;
      const target = wanted ?? [...hub.sessions.values()].at(-1) ?? hub.create(conn.cols, conn.rows);
      attach(conn, target.sid);
      break;
    }
    case "new": {
      const session = hub.create(conn.cols, conn.rows);
      attach(conn, session.sid);
      break;
    }
    case "kill":
      hub.kill(line.sid);
      break;
    case "attach":
      attach(conn, line.sid);
      break;
    case "ch": {
      const session = hub.sessions.get(conn.attachedSid);
      if (session && line.s.length <= 256) {
        if (conn.scrollback !== 0) conn.scrollback = 0; // typing snaps to live
        // More than one character at a time is a paste, not typing, and a
        // program that asked for bracketed paste wants to be told which.
        session.write(line.s);
      }
      break;
    }
    case "paste": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (line.phase === "single") { session.paste(line.s); conn.paste = undefined; break; }
      if (line.phase === "start") conn.paste = { sid: session.sid, text: "", at: Date.now() };
      const paste = conn.paste;
      if (!paste || paste.sid !== session.sid || Date.now() - paste.at > 15000 || paste.text.length + line.s.length > 8192) {
        conn.paste = undefined; throw new Error("Paste expired or exceeds budget");
      }
      paste.text += line.s; paste.at = Date.now();
      if (line.phase === "end") { session.paste(paste.text); conn.paste = undefined; }
      conn.scrollback = 0;
      break;
    }
    case "key": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (conn.scrollback !== 0) conn.scrollback = 0;
      session.write(encodeKey(line.k, line.ctrl === 1, line.alt === 1, session.appCursor(), line.shift === 1));
      break;
    }
    case "scroll": {
      if (conn.localHistory) break;
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      const max = session.core?.getScrollbackCount() ?? 0;
      conn.scrollback = Math.max(0, Math.min(max, conn.scrollback + line.d));
      // Scrolling changes this replica's view without any PTY byte to
      // announce it.
      scheduleFlush();
      break;
    }
    case "glyphs":
      if (line.reset) conn.pendingGlyphs = [];
      if (!conn.pendingGlyphs) throw new Error("Glyph demand needs an opening chunk");
      conn.pendingGlyphs.push(...[...line.one].map(ch => [ch.codePointAt(0)!, 1] as [number, number]),
        ...[...line.two].map(ch => [ch.codePointAt(0)!, 2] as [number, number]));
      if (conn.pendingGlyphs.length > 1024) { conn.pendingGlyphs = undefined; throw new Error("Visible glyph budget exceeded"); }
      if (!line.more) { conn.historyGlyphs = conn.pendingGlyphs; conn.pendingGlyphs = undefined; }
      scheduleFlush();
      break;
    case "resync":
      conn.atlasSent.clear(); conn.atlasQueue = [];
      snapshot(conn);
      break;
  }
}

// ---------------------------------------------------------------------------
// loopback mirror wire server
// ---------------------------------------------------------------------------

function acceptSocket(socket: Socket, mirrorSid?: number) {
  if (hub.conns.size >= 64) { socket.destroy(); return; }
  socket.setTimeout(15000, () => socket.destroy());
  socket.setNoDelay(true);
  const conn = new Conn({ kind: "pknt", socket });
  conn.mirrorSid = mirrorSid;

  socket.on("data", (chunk: Buffer) => {
    conn.lastRx = Date.now();
    let bytes = new Uint8Array(chunk);
    try {
      if (conn.hello !== null) {
        const merged = new Uint8Array(conn.hello.length + bytes.length);
        merged.set(conn.hello);
        merged.set(bytes, conn.hello.length);
        const hello = parseHello(merged);
        if (hello === null) {
          conn.hello = merged;
          return;
        }
        if (hello.app !== TERM_APP) throw new Error(`unknown app "${hello.app}"`);
        conn.hello = null;
        socket.write(encodeHelloAck());
        hub.conns.add(conn);
        console.log(`[term] device connected (${socket.remoteAddress ?? "?"})`);
        bytes = merged.slice(hello.consumed);
        if (bytes.length === 0) return;
      }
      for (const frame of conn.parser.push(bytes)) {
        if (frame.type === WIRE_MSG.pong) continue;
        if (frame.type !== WIRE_MSG.ctrl) continue; // forward compatibility
        const text = new TextDecoder().decode(frame.payload);
        try {
          handleLine(conn, JSON.parse(text) as ClientLine);
        } catch {
          // A malformed device line is a device bug; skip it rather than drop.
        }
      }
    } catch (error) {
      console.log(`[term] dropping device: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const cleanup = () => {
    hub.conns.delete(conn);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}
const server = createServer(socket => acceptSocket(socket));

let pingToken = 1;
setInterval(() => {
  const now = Date.now();
  for (const conn of hub.conns) {
    // Only PKNT sockets exchange these ping/pong frames and update lastRx.
    // Relay and offload replicas retain their own lifetime and flow control.
    if (conn.transport.kind !== "pknt") continue;
    const socket = conn.transport.socket;
    if (now - conn.lastRx > SILENCE_TIMEOUT_MS) {
      console.log("[term] device silent, dropping");
      socket.destroy();
      hub.conns.delete(conn);
      continue;
    }
    const token = new Uint8Array(4);
    new DataView(token.buffer).setUint32(0, pingToken++ >>> 0, true);
    socket.write(encodeFrame(WIRE_MSG.ping, token));
  }
}, PING_INTERVAL_MS);

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushAll(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // What a session is running changes without any output to announce it —
  // launching an editor, or leaving one.
  for (const session of hub.sessions.values()) session.refreshTitle();
  for (const conn of hub.conns) flush(conn);
  // Only visible history asks for glyph residency. Prefetching hundreds of
  // other rows must not evict the glyphs the user is currently reading.
  for (const conn of hub.conns) {
    if (conn.mailbox && Date.now() - conn.mailbox.touched > 15000) continue;
    for (const [cp, columns] of conn.historyGlyphs) {
      const slot = atlas.slotFor(cp, columns); if (slot >= 0) atlas.want(cp, columns, slot);
    }
  }
  pumpAtlasBake();
  relayAuthority?.pump();
}

/** Ask for a pass shortly. Output is what makes a session worth serializing,
 *  so a session that just parsed some announces itself rather than waiting
 *  for a poll to come round. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flushAll, FLUSH_COALESCE_MS);
}

setInterval(flushAll, FLUSH_IDLE_MS);

// ---------------------------------------------------------------------------
// mirror windows
// ---------------------------------------------------------------------------

/** One desktop window per session, tracked so it closes with its session. */
const mirrors = new Map<number, ChildProcess>();
const mirrorListeners = new Map<number, ReturnType<typeof createServer>>();

/** Open the desktop window for a session. The window is an ordinary
 *  PocketJS app (mirror/) on the stock desktop host, pointed at this
 *  daemon with --svc-connect; the listener binds it to its session. Nothing here is macOS-specific — the same binary is the linux-app
 *  host. */
function openMirror(sid: number, tcpPort: number): void {
  if (!options.mirror) return;
  if (!existsSync(MIRROR_BIN)) {
    console.log(
      `[term] no mirror window: ${MIRROR_BIN} is not built ` +
        `(bun run macos term-mirror --build-only), continuing without one`,
    );
    options.mirror = false;
    return;
  }
  const listener = createServer(socket => acceptSocket(socket, sid));
  mirrorListeners.set(sid, listener);
  listener.listen(0, "127.0.0.1", () => {
  if (!hub.sessions.has(sid)) { listener.close(); return; }
  const mirrorPort = (listener.address() as { port: number }).port;
  const child = spawn(
    MIRROR_BIN,
    [
      "--app", MIRROR_APP,
      "--title", `Pocket Term #${sid}`,
      "--viewport", "400x240",
      "--fixed",
      "--density", "2",
      "--companions", TERM_APP,
      "--svc-connect", `127.0.0.1:${mirrorPort}`,
    ],
    {
      env: { ...process.env, POCKETJS_DIST: join(ROOT, "dist"), RUST_LOG: "warn" },
      stdio: "ignore",
      detached: false,
    },
  );
  mirrors.set(sid, child);
  child.on("exit", () => {
    if (mirrors.get(sid) === child) { mirrors.delete(sid); listener.close(); mirrorListeners.delete(sid); }
  });
  child.on("error", (error) => {
    console.log(`[term] mirror window for #${sid} failed: ${error.message}`);
    mirrors.delete(sid); listener.close(); mirrorListeners.delete(sid);
  });
  });
}

function closeMirror(sid: number): void {
  mirrorListeners.get(sid)?.close(); mirrorListeners.delete(sid);
  const child = mirrors.get(sid);
  if (!child) return;
  mirrors.delete(sid);
  child.kill();
}

function closeAllMirrors(): void {
  for (const listener of mirrorListeners.values()) listener.close();
  mirrorListeners.clear();
  for (const [, child] of mirrors) child.kill();
  mirrors.clear();
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    relayAuthority?.close();
    closeAllMirrors();
    for (const session of hub.sessions.values()) session.dispose();
    if (signal !== "exit") process.exit(0);
  });
}

const started = () => {
  const bound = (server.address() as { port: number }).port;
  console.log(`[term] PKNT listener on tcp/${bound} (app "${TERM_APP}")`);
  if (options.mirror) {
    // Every session gets a window, including ones that already exist when
    // the mirror feature comes up.
    hub.onSessionCreated = (sid) => openMirror(sid, bound);
    for (const sid of hub.sessions.keys()) openMirror(sid, bound);
  }
};

// Local applications can already occupy the preferred port. Dedicated
// mirror listeners carry their actual ports, so the control listener may
// fall back to an ephemeral one.
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.log(`[term] tcp/${options.port} is taken — falling back to an ephemeral port`);
  server.listen(0, "127.0.0.1");
});
server.once("listening", started);
server.listen(options.port, "127.0.0.1");

console.log(`[term] shell ${options.shell}, host name "${options.name}"`);

// Authenticated local capability broker. The LAN transport only forwards to
// this process; reconnecting its worker never tears down a PTY.
const epoch = randomUUID(), relayBoot = randomBytes(16).toString("hex"), token = randomBytes(32).toString("hex");
const replicas = new Map<string, Conn>();
const broker = createHttpServer(async (request, response) => {
  if (request.method !== "POST" || !["/exchange", "/history", "/history-batch", "/input"].includes(request.url ?? "") || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(403).end(); return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) throw new Error("Request exceeds budget");
    }
    if (request.url === "/history-batch") {
      const input = JSON.parse(body) as HistoryBatchRequest;
      validateHistoryBatch(input);
      const reply = readHistoryBatch(input);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(reply));
      return;
    }
    if (request.url === "/history") {
      const input = JSON.parse(body) as HistoryRequest;
      if (!Number.isSafeInteger(input.sid) || !Number.isSafeInteger(input.part) || input.part < 0 || input.part > Math.ceil(HISTORY.rowChars / HISTORY.fragmentChars)) throw new Error("Invalid history request");
      const session = hub.sessions.get(input.sid);
      if (!session?.core) throw new Error("Terminal no longer exists");
      const offset = session.history.offset(input.row, input.epoch);
      const cells: Cell[] = [];
      for (let x = 0; x < session.cols; x++) {
        const cell = resolveCell(session.core.getScrollbackCell(offset, x)); classify(cell, false); cells.push(cell);
      }
      const raw = JSON.stringify(rowRuns(cells));
      if (raw.length > HISTORY.rowChars) throw new Error("History row exceeds budget");
      const parts = Math.ceil(raw.length / HISTORY.fragmentChars);
      if (input.part >= parts) throw new Error("Invalid history fragment");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ epoch: input.epoch, row: input.row, part: input.part, parts,
        data: raw.slice(input.part * HISTORY.fragmentChars, (input.part + 1) * HISTORY.fragmentChars) }));
      scheduleFlush();
      return;
    }
    const input = JSON.parse(body) as ExchangeRequest;
    if (typeof input.replica !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(input.replica)) throw new Error("Invalid replica");
    let conn = replicas.get(input.replica);
    if (!conn) {
      if (replicas.size >= LIMITS.replicas) {
        const idle = [...replicas].sort((a, b) => a[1].mailbox!.touched - b[1].mailbox!.touched)[0];
        if (idle && Date.now() - idle[1].mailbox!.touched > 15000) {
          replicas.delete(idle[0]); hub.conns.delete(idle[1]);
        }
      }
      if (replicas.size >= LIMITS.replicas) throw new Error("Replica limit reached");
      // This adapter owns no socket; PTYs and views remain in the same hub
      // as the loopback desktop mirrors.
      conn = new Conn({ kind: "offload", mailbox: new Mailbox() });
      replicas.set(input.replica, conn); hub.conns.add(conn);
    }
    const reply = request.url === "/input"
      ? conn.mailbox!.input(input as unknown as import("../shared/exchange.ts").InputRequest, `${epoch}-${conn.mailbox!.identity}`, line => handleLine(conn!, line))
      : conn.mailbox!.exchange(input, `${epoch}-${conn.mailbox!.identity}`, line => handleLine(conn!, line));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply));
    if (!conn.mailbox!.busy) scheduleFlush();
  } catch (error) { response.writeHead(400).end(String(error).slice(0, 160)); }
});
broker.requestTimeout = 5000;
broker.listen(0, "127.0.0.1", () => {
  const endpoint = `http://127.0.0.1:${(broker.address() as { port: number }).port}/exchange`;
  process.send?.({ ready: true, endpoint, token });
  console.log("[term] durable terminal worker ready (paired offload + loopback mirrors)");
});
setInterval(() => {
  for (const [id, conn] of replicas) {
    if (Date.now() - conn.mailbox!.touched > 30 * 60 * 1000) {
      replicas.delete(id); hub.conns.delete(conn);
    }
  }
  for (const [id, held] of relayReplicas) if (!held.conn.relaySink && Date.now() - held.touched > 30 * 60 * 1000) {
    relayReplicas.delete(id); hub.conns.delete(held.conn);
  }
}, 60000).unref();

function readHistoryBatch(input: HistoryBatchRequest): ReturnType<typeof historyBatchReply> {
  validateHistoryBatch(input);
  const session = hub.sessions.get(input.sid);
  if (!session?.core) throw new Error("Terminal no longer exists");
  for (const row of input.rows) session.history.offset(row, input.epoch);
  return historyBatchReply(input, row => {
    const offset = session.history.offset(row, input.epoch), cells: Cell[] = [];
    for (let x = 0; x < session.cols; x++) {
      const cell = resolveCell(session.core!.getScrollbackCell(offset, x)); classify(cell, false); cells.push(cell);
    }
    return JSON.stringify(rowRuns(cells));
  });
}

const relayReplicas = new Map<string, { conn: Conn; touched: number }>();
function createRelayReplica(ns: string, _peer: unknown, sink: TermRelaySink): TermRelayReplica {
  let held = relayReplicas.get(ns);
  if (!held) {
    if (relayReplicas.size >= LIMITS.replicas) throw new Error("Relay replica limit reached");
    const conn = new Conn({ kind: "relay", sink });
    held = { conn, touched: Date.now() }; relayReplicas.set(ns, held); hub.conns.add(conn);
  }
  const conn = held.conn; conn.relaySink = sink; held.touched = Date.now();
  return {
    get ack() { return conn.relayAck; },
    resume() { snapshot(conn); pumpAtlasSend(conn); },
    state: () => ({
      boot: relayBoot, name: options.name, proto: TERM_PROTO, active: conn.attachedSid, ack: conn.relayAck, bell: 0,
      sessions: hub.list(), fonts: atlas.current().map(font => ({ slot: font.slot, gen: font.gen })),
      ...(conn.attachedSid >= 0 && conn.gen > 0 ? { grid: { sid: conn.attachedSid, gen: conn.gen } } : {}),
    }),
    apply(line, id) { conn.relayAck = id; held!.touched = Date.now(); handleLine(conn, line); },
    history: readHistoryBatch,
    font(slot) { const current = atlas.current().find(font => font.slot === slot); return current && { gen: current.gen, bytes: current.bytes }; },
    close() { if (conn.relaySink === sink) conn.relaySink = undefined; held!.touched = Date.now(); },
  };
}

let relayAuthority: Awaited<ReturnType<typeof serveTermRelay>>["authority"] | undefined;
const relayKey = process.env.POCKET_TERM_RELAY_KEY;
if (process.env.POCKET_TERM_TRANSPORT === "relay" && relayKey) {
  const relay = await serveTermRelay({ key: relayKey, port: Number(process.env.POCKET_TERM_RELAY_PORT ?? 8742), host: "0.0.0.0",
    store: new TermOperationJournal(process.env.POCKET_TERM_RELAY_JOURNAL ?? resolve(ROOT, ".pocket/relay-operations.json")),
    createReplica: createRelayReplica, log: message => console.log(`[term] ${message}`) });
  relayAuthority = relay.authority;
  console.log(`[term] relay authority listening on tcp/${relay.port}`);
  process.send?.({ relayReady: true, port: relay.port });
}
