import { batch, createSignal, onCleanup, type Accessor } from "solid-js";
import { createScroller } from "@pocketjs/framework/kinetics";
import { createResourceScheduler } from "@pocketjs/framework/resource-cache";
import type { ResourceDemand, ResourceLoad } from "@pocketjs/framework/resource-cache";
import { HISTORY, HISTORY_BATCH, decodeHistoryRow, historyKey, validManifest, type HistoryInput, type HistoryManifest, type HistoryReply } from "../shared/history.ts";
import type { Run } from "../shared/protocol.ts";
import { createHistoryBatchLoader } from "./history-batch.ts";

export interface HistoryIO {
  request(method: string, payload: string, callback: (result: { ok: true; value: string } | { ok: false; error: unknown }) => void): number;
  cancel(id: number): void;
}

/** Reads have their own cancellable tickets; they never wait behind queued
 * terminal input and can never execute a PTY mutation on retry. */
export function historyLoader(io: HistoryIO): ResourceLoad<HistoryInput, string> {
  return (input, complete) => {
    let id = 0, closed = false, part = 0, parts = 0, raw = "";
    const next = (): boolean => {
      id = io.request("term.history", JSON.stringify({ ...input, part }), result => {
        id = 0;
        if (closed) return;
        if (!result.ok) { closed = true; complete(result); return; }
        try {
          const p = JSON.parse(result.value) as HistoryReply;
          if (p.epoch !== input.epoch || p.row !== input.row || p.part !== part ||
              !Number.isInteger(p.parts) || p.parts < 1 || p.parts > Math.ceil(HISTORY.rowChars / HISTORY.fragmentChars) ||
              parts && p.parts !== parts || typeof p.data !== "string" || p.data.length > HISTORY.fragmentChars ||
              raw.length + p.data.length > HISTORY.rowChars) throw new Error("Invalid history fragment");
          raw += p.data; parts = p.parts; part++;
          if (part === parts) { closed = true; complete({ ok: true, value: raw }); }
          else if (!next()) throw new Error("History transport busy");
        } catch (cause) { closed = true; complete({ ok: false, error: String(cause).slice(0, 120) }); }
      });
      return id !== 0;
    };
    if (!next()) return false;
    return { cancel() { closed = true; if (id) io.cancel(id); raw = ""; } };
  };
}

export function historyDemand(sid: number, m: HistoryManifest, first: number, direction: number, visible = 26): ResourceDemand<HistoryInput>[] {
  if (m.alternate) return [];
  const demand: ResourceDemand<HistoryInput>[] = [], seen = new Set<number>();
  const add = (row: number, pin: boolean) => {
    if (row < m.first || row >= m.end || seen.has(row) || demand.length >= HISTORY.demand) return;
    seen.add(row); demand.push({ input: { sid, epoch: m.epoch, row }, priority: demand.length + (pin ? 0 : 30), pin });
  };
  for (let n = 0; n < visible; n++) add(first + n, true);
  // A live view warms its newest history; movement biases future addresses
  // without removing the useful rows immediately behind the viewport.
  for (let n = 1; n <= HISTORY.demand; n++) {
    if (direction <= 0) { add(first - n, false); if (n % 3 === 0) add(first + visible + n / 3 - 1, false); }
    else { add(first + visible + n - 1, false); if (n % 3 === 0) add(first - n / 3, false); }
  }
  return demand;
}

export function createTermHistory(io: HistoryIO, liveRow: (y: number) => Accessor<Run[]>, rows: number, cellH: number,
  glyphs?: { ready(runs: Run[]): boolean; demand(rows: Run[][]): boolean }, canLoad: () => boolean = () => true) {
  const [manifest, setManifest] = createSignal<HistoryManifest | undefined>(undefined, { equals: (a, b) =>
    a?.epoch === b?.epoch && a?.first === b?.first && a?.end === b?.end && a?.alternate === b?.alternate });
  const [sid, setSid] = createSignal(-1), [first, setFirst] = createSignal(0);
  let online = false, following = true, direction = -1;
  const maximum = () => { const m = manifest(); return m ? (m.end - m.first) * cellH : 0; };
  const scroller = createScroller({ max: maximum, extent: () => rows * cellH, overscroll: 0 });
  const revisions = Array.from({ length: rows + 2 }, () => createSignal(0));
  const dirty = new Set<number>();
  let planned = "", plans = 0, demands = 0;
  const available = () => online && !!manifest() && canLoad();
  const loader = createHistoryBatchLoader(io);
  const runtime = createResourceScheduler({ maxCollections: 1, maxConcurrent: HISTORY_BATCH.pendingRows,
    startsPerFrame: HISTORY_BATCH.rows, completionsPerFrame: HISTORY_BATCH.materializeRows, available });
  onCleanup(runtime.dispose);
  const cache = runtime.createCache({ key: historyKey, maxEntries: HISTORY.entries,
    maxCost: HISTORY.entries * 65536, cost: () => 65536, maxResponseBytes: HISTORY.rowChars * 2,
    retry: { attempts: 3, delayFrames: 45, maxDelayFrames: 180 }, load: loader.load, materialize: decodeHistoryRow,
    changed(input) { if (input.sid === sid() && input.epoch === manifest()?.epoch) dirty.add(input.row); } });
  // Fixed geometry means demand changes only at an eight-row boundary,
  // direction change or authoritative manifest update. The generic view
  // adapter replans every frame; use its public scheduler with an explicit
  // product planner so idle frames do not allocate/reconcile 144 identities.
  const plan = () => {
    const m = manifest(), bucket = Math.floor(first() / 8) * 8;
    const key = m ? `${sid()}/${m.epoch}/${m.first}/${m.end}/${bucket}/${direction}` : "empty";
    if (key === planned) return;
    planned = key; plans++;
    const wanted = m ? historyDemand(sid(), m, bucket, direction, rows + 9) : [];
    demands = wanted.length; cache.reconcile(wanted);
  };
  const value = (row: number): Run[] | undefined => {
    const m = manifest(); if (!m) return;
    const state = cache.state({ sid: sid(), epoch: m.epoch, row });
    return state.status === "ready" ? state.value : undefined;
  };
  const updateFirst = () => { const m = manifest(); setFirst((m?.first ?? 0) + Math.floor(Math.round(scroller.offset()) / cellH)); };
  const usable = () => !!manifest() && !manifest()!.alternate;
  const goLive = () => { following = true; scroller.scrollTo(maximum(), { immediate: true }); updateFirst(); };
  let lastGlyphRows: (Run[] | undefined)[] = [], glyphCooldown = 0;
  return {
    manifest, first, scroller,
    select(next: number) {
      if (sid() === next) return;
      runtime.cancel(); planned = ""; setSid(next); setManifest(undefined); following = true;
      scroller.scrollTo(0, { immediate: true }); updateFirst();
    },
    adopt(next: number, m: HistoryManifest) {
      if (!validManifest(m)) throw new Error("Invalid terminal history manifest");
      const old = manifest(), changed = next !== sid() || !old || old.epoch !== m.epoch;
      if (changed) {
        runtime.cancel();
        cache.invalidate(i => i.sid === next && i.epoch !== m.epoch, true);
        following = true;
      }
      setSid(next); setManifest(m);
      if (following || m.alternate) goLive();
      else if (old && old.first !== m.first) {
        scroller.rebase((old.first - m.first) * cellH);
        if (scroller.offset() < 0) scroller.scrollTo(0, { immediate: true });
      }
      updateFirst();

    },
    setOnline(value: boolean) { if (online && !value) runtime.cancel(); online = value; },
    reset() { runtime.cancel(); cache.clear(); planned = ""; setManifest(undefined); following = true; scroller.scrollTo(0, { immediate: true }); updateFirst(); },
    frame() {
      const before = scroller.offset(); scroller.step();
      if (scroller.offset() < 0 || scroller.offset() > maximum()) scroller.scrollTo(Math.max(0, Math.min(maximum(), scroller.offset())), { immediate: true });
      const motion = scroller.offset() - before;
      if (motion !== 0) direction = Math.sign(motion);
      if (scroller.state() === "idle" && scroller.offset() >= maximum() - 0.5) following = true;
      updateFirst();
      batch(() => {
        plan(); loader.publish(); runtime.step(); loader.step(available());
        for (const row of dirty) if (row >= first() && row < first() + rows + 2) revisions[row % revisions.length][1](n => n + 1);
        dirty.clear();
      });
      const m = manifest(), current: (Run[] | undefined)[] = [];
      if (m && scroller.offset() < maximum() - 0.5) for (let y = first(); y < first() + rows + 1 && y < m.end; y++) {
        current.push(value(y));
      }
      if (glyphCooldown > 0) glyphCooldown--;
      if (online && !glyphCooldown && (current.length !== lastGlyphRows.length || current.some((row, i) => row !== lastGlyphRows[i]))) {
        glyphCooldown = 8;
        if (!glyphs || glyphs.demand(current.filter((row): row is Run[] => row !== undefined))) lastGlyphRows = current;
      }
    },
    nudge(px: number) { if (usable() && px) { following = false; direction = Math.sign(px); scroller.nudge(px); } },
    scroll(lines: number) { if (usable() && lines) { following = false; direction = -Math.sign(lines); scroller.scrollBy(-lines * cellH); } },
    beginDrag() { if (usable()) { following = false; scroller.beginDrag(); } },
    drag(px: number) { if (usable()) { following = false; direction = Math.sign(px) || direction; scroller.drag(px); updateFirst(); } },
    endDrag(velocity: number) { if (usable()) scroller.endDrag(Math.max(-4800, Math.min(4800, velocity))); },
    stop() { scroller.stop(); }, goLive,
    back: () => Math.max(0, Math.ceil((maximum() - scroller.offset()) / cellH)),
    translation(origin: number) { return -((manifest()?.first ?? 0) - origin) * cellH - Math.round(scroller.offset()); },
    row(row: number): Run[] | undefined {
      const m = manifest();
      if (!m) return row >= 0 && row < rows ? liveRow(row)() : [];
      if (row >= m.end) return row < m.end + rows ? liveRow(row - m.end)() : [];
      if (row < m.first) return [];
      revisions[row % revisions.length][0]();
      const runs = value(row);
      return runs && (!glyphs || glyphs.ready(runs)) ? runs : undefined;
    },
    rowError(row: number) {
      const m = manifest(); return !!m && row >= m.first && row < m.end && cache.state({ sid: sid(), epoch: m.epoch, row }).status === "error";
    },
    stats: () => ({ ...cache.stats(), plans, demands, transport: loader.stats() }),
    dispose: runtime.dispose,
  };
}
export type TermHistory = ReturnType<typeof createTermHistory>;
