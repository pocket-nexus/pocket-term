// Visible terminal replica. Completed grid generations commit atomically;
// sequence gaps request a snapshot. PTYs and scrollback remain on the Mac.

import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import { virtualNow } from "@pocketjs/framework/clock";
import { getOps } from "@pocketjs/framework/host";
import {
  DYNAMIC_SLOTS,
  TERM_PROTO,
  type ClientLine,
  type Cursor,
  type HostInputLine,
  type HostLine,
  type KeyName,
  type Role,
  type Run,
  type SessionInfo,
  isDynamicSlot,
} from "../shared/protocol.ts";
import type { TermChannel, TermChannelEvent } from "./channel.ts";
import { createTermHistory, type TermHistory } from "./history.ts";
import { createTypingPrediction, type TypingPreview } from "./prediction.ts";

export type ConnState = "no-svc" | "search" | "link" | "live";

/** 0xRRGGBB -> the ABGR u32 the engine's color props carry. */
export function rgbToAbgr(rgb: number): number {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff)) >>> 0;
}

const RESYNC_COOLDOWN_FRAMES = 30;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) table[BASE64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Decode base64 into bytes. The engine's own codec lives in an internal
 *  module (framework/src/bytes.ts, no published subpath), and a font atlas is
 *  the only binary this app carries, so it brings its own. */
function base64ToBytes(text: string): Uint8Array {
  let length = text.length;
  while (length > 0 && text.charCodeAt(length - 1) === 61) length -= 1; // '='
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let at = 0;
  let bits = 0;
  let width = 0;
  for (let i = 0; i < length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? BASE64_VALUES[code] : -1;
    if (value < 0) continue;
    bits = (bits << 6) | value;
    width += 6;
    if (width >= 8) {
      width -= 8;
      out[at++] = (bits >> width) & 0xff;
    }
  }
  return at === out.length ? out : out.subarray(0, at);
}

export interface TermStore {
  history?: TermHistory;
  preview: Accessor<TypingPreview | undefined>;
  setPreview(on: boolean): void;
  conn: Accessor<ConnState>;
  hostName: Accessor<string>;
  sessions: Accessor<SessionInfo[]>;
  activeSid: Accessor<number>;
  row(y: number): Accessor<Run[]>;
  cursor: Accessor<Cursor | null>;
  scrollback: Accessor<number>;
  bell: Accessor<boolean>;
  /** Glyphs delivered at runtime for codepoints the build never baked; the
   *  count is what the status bar reports. */
  dynamicGlyphs: Accessor<number>;
  status(): string;
  dispose(): void;
  paste(s: string): void;
  /** Pump the channel — call exactly once per frame. */
  frame(): void;
  sendText(s: string): void;
  sendKey(k: KeyName | string, ctrl?: boolean, alt?: boolean, shift?: boolean): void;
  scroll(lines: number): void;
  newSession(): void;
  kill(sid: number): void;
  attach(sid: number): void;
  attachSibling(step: 1 | -1): void;
}

export interface TermStoreOptions {
  cols: number;
  rows: number;
  /** The measured cell box [w, h] in px — the companion bakes dynamic glyph
   *  advances and cell heights against it. */
  cell: [number, number];
  role?: Role;
}

export function createTermStore(options: TermStoreOptions, svc: TermChannel | null): TermStore {
  const { cols, rows, cell } = options;
  const role: Role = options.role ?? "device";
  const [conn, setConn] = createSignal<ConnState>(svc === null ? "no-svc" : "search");
  const [hostName, setHostName] = createSignal("");
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  const [activeSid, setActiveSid] = createSignal(-1);
  const [cursor, setCursor] = createSignal<Cursor | null>(null);
  const [scrollback, setScrollback] = createSignal(0);
  const [bell, setBell] = createSignal(false);
  const [dynamicGlyphs, setDynamicGlyphs] = createSignal(0);
  const [status, setStatus] = createSignal("");
  const rowSignals = Array.from({ length: rows }, () => createSignal<Run[]>([]));
  const [preview, setPreview] = createSignal<TypingPreview>();
  const prediction = createTypingPrediction(y => rowSignals[y][0](), cursor, setPreview, cols, rows);
  const displayedCursor = createMemo(() => preview()?.cursor ?? cursor());
  const coverage = new Map<number, Set<number>>();
  const [atlasVersion, setAtlasVersion] = createSignal(0);
  const history = svc?.historyIO ? createTermHistory(svc.historyIO, y => rowSignals[y][0], rows, cell[1], {
    ready(runs) {
      atlasVersion();
      return runs.every(run => !isDynamicSlot(run[4]) || [...run[1]].every(ch => coverage.get(run[4]!)?.has(ch.codePointAt(0)!)));
    },
    demand(rows) {
      const wanted = new Map<string, number>();
      for (const row of rows) for (const run of row) if (isDynamicSlot(run[4])) {
        const chars = [...run[1]], wide = (run[5] ?? run[1].length) > chars.length;
        for (const ch of chars) if (wanted.size < 1024) wanted.set(ch, wide ? 2 : 1);
      }
      const entries = [...wanted], lines: ClientLine[] = [];
      for (let at = 0; at < Math.max(1, entries.length); at += 224) {
        const chunk = entries.slice(at, at + 224);
        lines.push({ t: "glyphs", one: chunk.filter(e => e[1] === 1).map(e => e[0]).join(""), two: chunk.filter(e => e[1] === 2).map(e => e[0]).join(""),
          ...(at === 0 ? { reset: 1 as const } : {}), ...(at + 224 < entries.length ? { more: 1 as const } : {}) });
      }
      if (svc.sendBatch) return svc.sendBatch(lines);
      lines.forEach(line => svc.send(line)); return true;
    },
  }, () => !svc.inputPending?.()) : undefined;

  let wasOpen = false;
  let gen = -1;
  let seq = -1;
  let sawGrid = false;
  let staged: Map<number, Run[]> | undefined;
  let resyncCooldown = 0;
  let bellFrames = 0;
  /** Survives a reconnect so the console comes back to the session it was
   *  looking at rather than to whichever one the host lists last. */
  let lastWanted = -1;

  // Atlas reassembly, per slot: the companion bakes one atlas per face in
  // its fallback chain. A bake arrives as ordered chunks; a device that
  // joins mid-bake has no use for the tail and waits for the next one.
  interface AtlasRx {
    gen: number;
    seq: number;
    parts: string[];
    chars: number;
  }
  const atlasRx = new Map<number, AtlasRx>();
  const glyphCounts = new Map<number, number>();

  const clearGrid = () => {
    for (const [, set] of rowSignals) set([]);
    prediction.reset(); setCursor(null);
    setScrollback(0);
  };

  const requestResync = () => {
    if (resyncCooldown > 0) return;
    resyncCooldown = RESYNC_COOLDOWN_FRAMES;
    svc?.send({ t: "resync" });
  };

  const applyAtlas = (line: Extract<HostLine, { t: "atlas" }>) => {
    if (!(DYNAMIC_SLOTS as readonly number[]).includes(line.slot) || typeof line.b64 !== "string" || line.b64.length > 6144) return;
    let rx = atlasRx.get(line.slot);
    if (rx === undefined || line.gen !== rx.gen) {
      if (line.seq !== 0) return; // joined mid-bake; the next one starts clean
      rx = { gen: line.gen, seq: -1, parts: [], chars: 0 };
      atlasRx.set(line.slot, rx);
    }
    if (line.seq !== rx.seq + 1) {
      atlasRx.delete(line.slot);
      requestResync();
      return;
    }
    rx.seq = line.seq;
    if (rx.chars + line.b64.length > 262144) { atlasRx.delete(line.slot); requestResync(); return; }
    rx.parts.push(line.b64); rx.chars += line.b64.length;
    if (line.more === 1) return;
    const blob = base64ToBytes(rx.parts.join(""));
    rx.parts = []; rx.chars = 0;
    const load = getOps().loadFontAtlas;
    if (!load || blob.length < 16) return;
    load(blob);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength), count = view.getUint16(6, true);
    if (16 + count * 8 <= blob.length) {
      coverage.set(line.slot, new Set(Array.from({ length: count }, (_, n) => view.getUint32(16 + n * 8, true))));
      setAtlasVersion(n => n + 1);
    }
    // Each blob's header carries its own glyph count (spec FONT ATLAS v3);
    // the status line reports the whole chain's.
    glyphCounts.set(line.slot, blob[6] | (blob[7] << 8));
    let total = 0;
    for (const count of glyphCounts.values()) total += count;
    setDynamicGlyphs(total);
  };

  const applyFont = (line: Extract<TermChannelEvent, { t: "font" }>) => {
    const blob = line.data, load = getOps().loadFontAtlas;
    if (!load || blob.length < 16) return;
    load(blob);
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength), count = view.getUint16(6, true);
    coverage.set(line.slot, new Set(Array.from({ length: count }, (_, n) => view.getUint32(16 + n * 8, true))));
    glyphCounts.set(line.slot, count);
    let total = 0; for (const value of glyphCounts.values()) total += value;
    setDynamicGlyphs(total); setAtlasVersion(n => n + 1);
  };

  const applyGrid = (line: Extract<HostLine, { t: "grid" }>) => {
    if (line.sid !== activeSid() && activeSid() !== -1) return;
    if (line.gen < gen) return;
    if (line.gen > gen) {
      // A gen opens with a full snapshot at seq 0; joining later means the
      // head was dropped somewhere and only a fresh snapshot can help.
      if (line.seq !== 0 || !line.full) {
        gen = line.gen; // remember it so the resync's higher gen adopts
        requestResync();
        return;
      }
      gen = line.gen;
      seq = -1;
      staged = new Map();
    }
    if (line.seq !== seq + 1) {
      if (line.seq <= seq) return; // duplicate; TCP makes this a host bug
      requestResync();
      return;
    }
    seq = line.seq;
    if (!staged) staged = new Map();
    for (const update of line.rows) {
      const [y, ...runs] = update;
      if (y >= 0 && y < rows) staged.set(y, runs);
    }
    if (line.more) return;
    batch(() => {
      if (line.full || line.history && line.history.epoch !== history?.manifest()?.epoch) prediction.reset();
      for (const [y, runs] of staged!) rowSignals[y][1](runs);
      staged = undefined;
      if (line.cur) setCursor(line.cur);
      if (line.sb !== undefined) setScrollback(line.sb);
      if (line.history) history?.adopt(line.sid, line.history);
      sawGrid = true;
      prediction.authoritative(line.ack, virtualNow() * 1000);
      setConn("live");
    });
  };

  const sendText = (s: string) => {
    if (!wasOpen || activeSid() < 0) return;
    if (s.length > 0 && s.length <= 256) {
      history?.goLive(); const line: ClientLine = { t: "ch", s }, id = svc?.send(line);
      if (id && conn() === "live") prediction.input(line, id, virtualNow() * 1000); else prediction.reset();
    }
  };
  const sendKey = (k: KeyName | string, ctrl?: boolean, alt?: boolean, shift?: boolean) => {
    if (!wasOpen || activeSid() < 0) return;
    history?.goLive();
    const line: ClientLine = {
      t: "key",
      k,
      ...(ctrl ? { ctrl: 1 as const } : {}),
      ...(alt ? { alt: 1 as const } : {}),
      ...(shift ? { shift: 1 as const } : {}),
    };
    const id = svc?.send(line);
    if (id && conn() === "live") prediction.input(line, id, virtualNow() * 1000); else prediction.reset();
  };
  const paste = (text: string) => {
    if (!wasOpen || activeSid() < 0 || !text) return;
    prediction.reset(); history?.goLive();
    if (text.length > 8192) { setStatus("Paste exceeds 8192 characters"); return; }
    const chunks: string[] = [];
    for (let at = 0; at < text.length;) {
      let end = Math.min(text.length, at + 128);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      chunks.push(text.slice(at, end)); at = end;
    }
    const lines: ClientLine[] = chunks.map((s, i) => ({ t: "paste", s, phase: chunks.length === 1 ? "single" : i === 0 ? "start" : i === chunks.length - 1 ? "end" : "more" }));
    if (svc?.sendBatch) svc.sendBatch(lines);
    else lines.forEach(line => svc?.send(line));
  };
  const scroll = (lines: number) => {
    prediction.reset();
    if (history) history.scroll(lines);
    else if (lines !== 0) svc?.send({ t: "scroll", d: lines });
  };

  const apply = (line: TermChannelEvent) => {
    switch (line.t) {
      case "transport-reset":
        gen = -1; seq = -1; staged = undefined; sawGrid = false;
        clearGrid(); atlasRx.clear(); glyphCounts.clear(); setDynamicGlyphs(0);
        history?.reset();
        coverage.clear(); setAtlasVersion(n => n + 1);
        setConn("link");
        break;
      case "hello":
        // The local host says hello too, with a viewport and no proto. Only
        // the companion's introduces the session.
        if (!("proto" in line)) break;
        setHostName(line.name);
        if (line.sid !== undefined) {
          setActiveSid(line.sid);
          lastWanted = line.sid;
        }
        break;

      // Input from the machine this replica runs on (hosts/desktop forwards
      // the window's keystrokes). The companion owns the PTY, so a window
      // types by relaying, not by echoing anything locally.
      case "ch":
        sendText(line.s);
        break;
      case "key":
        sendKey(line.k, line.ctl === true, line.alt === true, line.sh === true);
        break;
      case "paste":
        paste(line.text);
        break;
      case "scroll":
        // A wheel notch is worth a line of history.
        scroll(-Math.sign(line.dy) * Math.max(1, Math.round(Math.abs(line.dy) / 20)));
        break;
      case "resize":
      case "load":
      case "mouse":
      case "ime":
        // Not part of a terminal replica's contract: the grid is sized by
        // the console, and a commit arrives as its own "ch" line.
        break;
      case "sessions":
        setSessions(line.list);
        if (line.active !== activeSid()) {
          clearGrid(); sawGrid = false; staged = undefined; setConn("link");
          setActiveSid(line.active);
          history?.select(line.active);
          if (line.active >= 0) lastWanted = line.active;
        }
        if (line.list.length === 0) {
          // Nothing is attached any more: drop the last session's screen
          // rather than leave a dead one on display, and forget the
          // generation so the next session's snapshot is adopted cleanly.
          clearGrid();
          gen = -1;
          seq = -1;
          sawGrid = false;
          staged = undefined;
          lastWanted = -1;
        }
        break;
      case "grid":
        applyGrid(line);
        break;
      case "atlas":
        applyAtlas(line);
        break;
      case "font":
        applyFont(line);
        break;
      case "exit":
        // The host follows with a sessions line; nothing to do locally.
        break;
      case "bell":
        bellFrames = 8;
        setBell(true);
        break;
    }
  };

  const attach = (sid: number) => {
    if (sid === activeSid()) return;
    prediction.reset(); lastWanted = sid;
    svc?.send({ t: "attach", sid });
  };

  return {
    history, preview, setPreview: prediction.enabled,
    conn,
    hostName,
    sessions,
    activeSid,
    row: (y) => rowSignals[y][0],
    cursor: displayedCursor,
    scrollback: () => history?.manifest() ? history.back() : scrollback(),
    bell,
    dynamicGlyphs,
    status,
    dispose() { history?.dispose(); svc?.dispose?.(); atlasRx.clear(); },
    paste,
    frame() {
      prediction.frame(virtualNow() * 1000);
      if (svc === null) return;
      const transportStatus = svc.status?.() ?? "";
      if (transportStatus) setStatus(transportStatus);
      if (resyncCooldown > 0) resyncCooldown -= 1;
      if (bellFrames > 0 && --bellFrames === 0) setBell(false);
      const open = svc.open();
      if (open && !wasOpen) {
        // Fresh transport (first frame or reconnect): re-introduce ourselves,
        // naming the session we were on so a reconnect is invisible.
        gen = -1;
        seq = -1;
        sawGrid = false;
        staged = undefined;
        atlasRx.clear();
        glyphCounts.clear();
        svc.send({
          t: "hello",
          proto: TERM_PROTO,
          cols,
          rows,
          cell,
          role,
          ...(history ? { history: 1 as const } : {}),
          ...(lastWanted >= 0 ? { want: lastWanted } : {}),
        });
      }
      wasOpen = open;
      if (!open) {
        prediction.reset(); setConn("search");
        history?.setOnline(false); history?.frame();
        return;
      }
      if (conn() !== "live" || !sawGrid) setConn(sawGrid ? "live" : "link");
      svc.step?.();
      for (const line of svc.poll()) apply(line);
      history?.setOnline(sawGrid && conn() === "live"); history?.frame();
    },
    sendText,
    sendKey,
    scroll,
    newSession() {
      prediction.reset(); svc?.send({ t: "new" });
    },
    kill(sid) {
      prediction.reset(); if (sid >= 0) svc?.send({ t: "kill", sid });
    },
    attach,
    attachSibling(step) {
      const list = sessions();
      if (list.length < 2) return;
      const at = list.findIndex((s) => s.sid === activeSid());
      const next = list[(at + step + list.length) % list.length];
      if (next) attach(next.sid);
    },
  };
}
