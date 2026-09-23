import { RelayEndpoint, type RelayOperationNamespace, type RelayOperationScope, type RelayOperationStore } from "@pocketjs/framework/relay/endpoint";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "@pocketjs/framework/relay/frame";
import { RELAY_CODEC, RELAY_KIND, RELAY_OP, RELAY_STATUS, RELAY_TYPE } from "@pocketjs/framework/relay/spec";
import type { RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import { encodeOffloadRecord } from "../vendor/pocketjs/tools/offload-wire.ts";
import { createTermChannel } from "../app/offload.ts";
import { createTermRelayChannel } from "../app/relay.ts";
import { Mailbox } from "../host/exchange.ts";
import { historyBatchReply } from "../host/history-batch.ts";
import { TermRelayAuthority, type TermRelayReplica, type TermRelaySink } from "../host/relay-host.ts";
import type { HistoryBatchReply, HistoryBatchRequest } from "../shared/history.ts";
import { TERM_RELAY, jsonBytes, termCapabilities } from "../shared/relay.ts";
import { TERM_PROTO, type ClientLine, type HostLine, type RowUpdate } from "../shared/protocol.ts";
import type { TermChannelEvent } from "../app/channel.ts";

export type TransportName = "offload" | "relay";
export interface Traffic { frames: number; bytes: number }
export interface WireRecord extends Traffic {
  from: "guest" | "provider";
  frame: RelayDecodedFrame;
}
export interface LegacyRecord extends Traffic { method: string; event?: HostLine["t"] }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Durable in-memory store for protocol tests. The production daemon uses
 * TermOperationJournal; this keeps the rig deterministic while preserving
 * authority-owned operation state across relay reconnections. */
export class RigOperationStore implements RelayOperationStore {
  readonly durable = true;
  private readonly states = new Map<string, RelayOperationNamespace>();
  transact<T>(scope: Readonly<RelayOperationScope>, update: (current: Readonly<RelayOperationNamespace> | undefined) => { state: RelayOperationNamespace; value: T }): T {
    const key = JSON.stringify([scope.authority, scope.writer, scope.ns]);
    const result = update(this.states.has(key) ? clone(this.states.get(key)!) : undefined);
    this.states.set(key, clone(result.state));
    return result.value;
  }
}

function scheduler(): RelayScheduler {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
}
function randomBytes(seed: number) {
  let state = seed >>> 0;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) { state = (state * 1664525 + 1013904223) >>> 0; out[i] = state >>> 24; }
    return out;
  };
}

export function font3(slot: number, generation: number, count = 3): Uint8Array {
  const width = 5, height = 10, out = new Uint8Array(16 + count * 8 + count * width * height);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x41464344, true); view.setUint16(4, 3, true); view.setUint16(6, count, true);
  out[8] = width; out[9] = height; out[12] = slot; out[14] = 1;
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 8;
    view.setUint32(at, 0x4e00 + generation * 16 + i, true); view.setUint16(at + 4, i, true); out[at + 6] = i === 1 ? 10 : 5;
    out.fill((generation * 29 + i * 17) & 0xff, 16 + count * 8 + i * width * height, 16 + count * 8 + (i + 1) * width * height);
  }
  return out;
}

const fullRows = (label: string): RowUpdate[] => Array.from({ length: 24 }, (_, y): RowUpdate => {
  if (y === 1) return [y, [0, "中", 0x55aaee, -1, 19, 2], [2, ` ${label}`, -1, 0x102030]];
  if (y === 23) return [y, [0, "wide span →", 0xffcc00, 0x10151c, undefined, 11]];
  return [y, [0, `${label} row ${String(y).padStart(2, "0")}`, y % 2 ? 0xd8dee9 : -1, y % 3 ? -1 : 0x202830]];
});

/** A deterministic terminal authority used by both transports. It emits the
 * same HostLine grid bytes the production worker emits after PTY parsing. */
export class FixtureTerminal {
  readonly boot = "0123456789abcdef0123456789abcdef";
  readonly applied: { id: number; line: ClientLine }[] = [];
  readonly grids: Extract<HostLine, { t: "grid" }>[] = [];
  ack = 0; active = -1; generation = 0; sequence = 0;
  sessions: { sid: number; title: string }[] = [];
  private nextSid = 1;
  private atlasGeneration = 0;
  private atlas: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private sink?: TermRelaySink;

  attach(sink: TermRelaySink): TermRelayReplica {
    this.sink = sink;
    const owner = this;
    return {
      get ack() { return owner.ack; },
      resume() { if (owner.active >= 0) owner.snapshot(); for (const item of owner.fonts()) sink.font(item.slot, item.gen); },
      state: () => owner.state(),
      apply: (line, id) => owner.apply(line, id),
      history: input => owner.history(input),
      font: slot => slot === 19 && owner.atlasGeneration > 0 ? { gen: owner.atlasGeneration, bytes: owner.atlas.slice() } : undefined,
      close() { if (owner.sink === sink) owner.sink = undefined; },
    };
  }

  private emit(line: HostLine) {
    if (line.t === "grid") this.grids.push(clone(line));
    this.sink?.line(line);
  }
  private fonts() { return this.atlasGeneration ? [{ slot: 19, gen: this.atlasGeneration }] : []; }
  state() {
    return { boot: this.boot, name: "Fixture Mac", proto: TERM_PROTO, active: this.active, ack: this.ack, bell: 0,
      sessions: clone(this.sessions), fonts: this.fonts(), ...(this.active > 0 && this.generation > 0 ? { grid: { sid: this.active, gen: this.generation } } : {}) };
  }
  private grid(line: Extract<HostLine, { t: "grid" }>) { this.emit(line); }
  snapshot() {
    if (this.active < 1) return;
    this.generation++; this.sequence = 0;
    const rows = fullRows(`session-${this.active}`);
    this.grid({ t: "grid", sid: this.active, gen: this.generation, seq: this.sequence++, full: 1, more: 1, rows: rows.slice(0, 12) });
    this.grid({ t: "grid", sid: this.active, gen: this.generation, seq: this.sequence++, full: 1, rows: rows.slice(12), cur: [12, 2, 1], ack: this.ack, sb: 0,
      history: { epoch: `history-${this.active}`, first: 0, end: 1200, alternate: false } });
  }
  private delta(text: string) {
    if (this.active < 1) return;
    this.grid({ t: "grid", sid: this.active, gen: this.generation, seq: this.sequence++, rows: [[2, [0, text, 0xabcdef, 0x010203]]],
      cur: [Math.min(79, text.length), 2, 1], ack: this.ack, sb: 0, history: { epoch: `history-${this.active}`, first: 0, end: 1200, alternate: false } });
  }
  apply(line: ClientLine, id: number) {
    this.ack = id; this.applied.push({ id, line: clone(line) });
    switch (line.t) {
      case "hello": {
        if (this.active < 1) { const sid = this.nextSid++; this.sessions.push({ sid, title: "fixture shell" }); this.active = sid; }
        this.emit({ t: "hello", proto: TERM_PROTO, name: "Fixture Mac", sid: this.active });
        this.emit({ t: "sessions", list: clone(this.sessions), active: this.active });
        if (!this.atlasGeneration) this.replaceFont(1);
        this.snapshot();
        break;
      }
      case "new": {
        const sid = this.nextSid++; this.sessions.push({ sid, title: `fixture ${sid}` }); this.active = sid;
        this.emit({ t: "sessions", list: clone(this.sessions), active: sid }); this.snapshot(); break;
      }
      case "kill": {
        this.sessions = this.sessions.filter(item => item.sid !== line.sid);
        if (this.active === line.sid) this.active = this.sessions.at(-1)?.sid ?? -1;
        this.emit({ t: "sessions", list: clone(this.sessions), active: this.active });
        if (this.active > 0) this.snapshot(); break;
      }
      case "attach": this.active = line.sid; this.emit({ t: "sessions", list: clone(this.sessions), active: this.active }); this.snapshot(); break;
      case "resync": this.snapshot(); break;
      case "ch": this.delta(`typed:${line.s}`); break;
      case "key": this.delta(`key:${line.k}:${line.ctrl ?? 0}:${line.alt ?? 0}:${line.shift ?? 0}`); break;
      case "paste": this.delta(`paste:${line.phase}:${line.s}`); break;
      case "scroll": this.delta(`scroll:${line.d}`); break;
      case "glyphs": this.delta(`glyphs:${line.one}:${line.two}`); break;
    }
  }
  replaceFont(generation = this.atlasGeneration + 1) {
    this.atlasGeneration = generation; this.atlas = font3(19, generation); this.sink?.font(19, generation);
  }
  replaceFontWithGlyphs(generation: number, count: number) {
    this.atlasGeneration = generation; this.atlas = font3(19, generation, count); this.sink?.font(19, generation);
  }
  font(slot: number, generation = this.atlasGeneration) {
    return slot === 19 && this.atlasGeneration === generation ? this.atlas.slice() : undefined;
  }
  history(input: HistoryBatchRequest): HistoryBatchReply {
    return historyBatchReply(input, row => JSON.stringify([[0, `history-${row.toString().padStart(4, "0")} 中`, row & 0xffffff, -1, 19, 18]]));
  }
}

const total = (records: readonly Traffic[]): Traffic => records.reduce((sum, item) => ({ frames: sum.frames + item.frames, bytes: sum.bytes + item.bytes }), { frames: 0, bytes: 0 });
export const wireTotal = (records: readonly Traffic[]) => total(records);

export function createOffloadRig() {
  const mailbox = new Mailbox(), records: LegacyRecord[] = [], events: TermChannelEvent[] = [];
  let nextTicket = 1;
  const pending: { id: number; method: string; payload: string; complete: (result: { ok: true; value: string } | { ok: false; error: string }) => void; requestBytes: number }[] = [];
  let outputText = "", outputFrames = 0, outputBytes = 0;
  const terminal = new FixtureTerminal();
  const pushFont = (slot: number, gen: number) => {
    const bytes = terminal.font(slot, gen); if (!bytes) throw new Error("fixture font generation missing");
    const b64 = Buffer.from(bytes).toString("base64");
    for (let at = 0, seq = 0; at < b64.length; at += 1536, seq++) mailbox.push({ t: "atlas", slot, gen, seq, ...(at + 1536 < b64.length ? { more: 1 as const } : {}), b64: b64.slice(at, at + 1536) });
  };
  terminal.attach({ line: line => mailbox.push(line), font: pushFont });
  const epoch = "legacy-fixture-epoch";
  const channel = createTermChannel({
    connected: () => true, session: () => 1, cancel(id) { const at = pending.findIndex(item => item.id === id); if (at >= 0) pending.splice(at, 1); },
    request(method, payload, complete) {
      const id = nextTicket++, raw = JSON.stringify({ v: 1, id, method, payload });
      pending.push({ id, method, payload, complete, requestBytes: encodeOffloadRecord(raw).length }); return id;
    },
  }, "rig-replica");

  function process() {
    const work = pending.splice(0);
    for (const item of work) {
      try {
        let value: string;
        if (item.method === "term.input") {
          const request = JSON.parse(item.payload), first = mailbox.ack + 1; let id = first;
          value = JSON.stringify(mailbox.input(request, epoch, line => terminal.apply(line, id++)));
        }
        else if (item.method === "term.history.batch") value = JSON.stringify(terminal.history(JSON.parse(item.payload)));
        else {
          const request = JSON.parse(item.payload);
          const reply = mailbox.exchange(request, epoch, line => terminal.apply(line, request.command.id)); value = JSON.stringify(reply);
        }
        const responseBytes = encodeOffloadRecord(JSON.stringify({ id: item.id, payload: value })).length;
        if (item.method === "term.exchange") {
          const reply = JSON.parse(value) as { data?: string; more?: boolean };
          outputFrames += 2; outputBytes += item.requestBytes + responseBytes;
          if (reply.data !== undefined) outputText += reply.data;
          if (reply.data !== undefined && !reply.more) {
            const event = JSON.parse(outputText) as HostLine;
            records.push({ method: item.method, event: event.t, frames: outputFrames, bytes: outputBytes });
            outputText = ""; outputFrames = outputBytes = 0;
          } else if (reply.data === undefined) { records.push({ method: item.method, frames: 2, bytes: item.requestBytes + responseBytes }); outputFrames = outputBytes = 0; }
        } else records.push({ method: item.method, frames: 2, bytes: item.requestBytes + responseBytes });
        item.complete({ ok: true, value });
      } catch (cause) { item.complete({ ok: false, error: String(cause).slice(0, 160) }); }
    }
  }
  async function frame() { events.push(...channel.poll()); process(); await Promise.resolve(); }
  async function until(predicate: () => boolean, limit = 10000) { for (let i = 0; !predicate(); i++) { if (i >= limit) throw new Error("offload rig did not settle"); await frame(); } }
  return { transport: "offload" as const, terminal, channel, records, events, frame, until, takeEvents: () => events.splice(0),
    metrics: (from = 0) => total(records.slice(from)), close: () => channel.dispose?.() };
}

export interface RelayRigOptions {
  grants?: string[];
  mutateProvider?: (frame: RelayDecodedFrame) => RelayDecodedFrame;
}

export function createRelayRig(options: RelayRigOptions = {}) {
  const records: WireRecord[] = [], events: TermChannelEvent[] = [], store = new RigOperationStore();
  const terminals = new Map<string, FixtureTerminal>(), authority = new TermRelayAuthority({ store, createReplica(ns, _peer, sink) {
    let terminal = terminals.get(ns); if (!terminal) terminals.set(ns, terminal = new FixtureTerminal()); return terminal.attach(sink);
  } });
  const peer = { id: "device-rig", grants: options.grants ?? ["term"] };
  let provider!: RelayEndpoint, connection!: ReturnType<TermRelayAuthority["connection"]>, client!: ReturnType<typeof createTermRelayChannel>;
  let dropProvider: ((frame: RelayDecodedFrame) => boolean) | undefined;
  const capture = (from: WireRecord["from"], bytes: Uint8Array, mutate = false) => {
    const decoded = decodeFrame(bytes, { maxWireBytes: TERM_RELAY.fontBytes + 8192, maxMetaBytes: 8192 });
    if (!decoded.ok) throw new Error(`invalid relay fixture frame: ${decoded.code}`);
    let frame = decoded.frame, wire: Uint8Array<ArrayBufferLike> = bytes.slice();
    if (mutate && options.mutateProvider) {
      frame = options.mutateProvider(frame); const encoded = encodeFrame(frame); if (!encoded.ok) throw new Error(encoded.code); wire = encoded.bytes;
    }
    records.push({ from, frame, frames: 1, bytes: wire.length }); return { frame, wire };
  };
  const guestTransport: RelayTransportAdapter = { peer: { id: "fixture-companion", grants: ["term"] }, trySend(bytes) {
    const record = capture("guest", bytes); provider.handleRecord(record.wire); return "accepted";
  } };
  const providerTransport: RelayTransportAdapter = { peer, trySend(bytes) {
    const record = capture("provider", bytes, true);
    if (!dropProvider?.(record.frame)) client.handleRecord(record.wire); return "accepted";
  } };
  const openProvider = () => {
    connection = authority.connection(peer);
    provider = new RelayEndpoint({ role: "provider", transport: providerTransport, local: termCapabilities(), privateOps: TERM_PRIVATE_OPS_FOR_RIG,
      resourceForms: TERM_RESOURCE_FORMS_FOR_RIG, operations: authority.operations, hooks: connection.hooks, scheduler: scheduler(), randomBytes: randomBytes(0x50) });
    connection.bind(provider);
  };
  const openClient = () => {
    client = createTermRelayChannel({ transport: guestTransport, replica: "rig-replica", scheduler: scheduler(), randomBytes: randomBytes(0x47), pingIntervalMs: 1e9, stallMs: 1e9 });
    client.connect();
  };
  openProvider(); openClient();
  async function frame() { client.step(); authority.pump(); provider.flush(); for (let i = 0; i < 8; i++) await Promise.resolve(); events.push(...client.poll()); }
  async function until(predicate: () => boolean, limit = 1000) { for (let i = 0; !predicate(); i++) { if (i >= limit) throw new Error(`relay rig did not settle: ${JSON.stringify(client.stats())}`); await frame(); } }
  const terminal = () => terminals.get("term/replica/rig-replica")!;
  return { transport: "relay" as const, authority, get client() { return client; }, records, events, terminal, frame, until, takeEvents: () => events.splice(0),
    metrics: (from = 0) => total(records.slice(from)), dropNext(predicate: (frame: RelayDecodedFrame) => boolean) { let used = false; dropProvider = frame => !used && predicate(frame) ? (used = true) : false; },
    clearDrop() { dropProvider = undefined; },
    async reconnect() { client.disconnect("rig link lost"); provider.handleDisconnect("rig link lost"); connection.close(); openProvider(); client.connect(); await frame(); },
    async reloadGuest(queued: readonly ClientLine[] = []) {
      client.disconnect("rig guest reload"); provider.handleDisconnect("rig guest reload"); connection.close(); openProvider(); openClient();
      for (const line of queued) client.send(line);
      await frame();
    },
    stream: () => [...(client.endpoint.inspect()?.allocations.keys() ?? [])].find(value => value !== 0) ?? 0,
    close() { client.disconnect("rig closed"); connection.close(); authority.close(); },
  };
}

// Aliases isolate the imports in one place so the rig mirrors the exact
// definitions installed by the product on both endpoints.
import { TERM_PRIVATE_OPS as TERM_PRIVATE_OPS_FOR_RIG, TERM_RESOURCE_FORMS as TERM_RESOURCE_FORMS_FOR_RIG } from "../shared/relay.ts";

export function isGridPush(record: WireRecord): boolean {
  return record.from === "provider" && record.frame.type === RELAY_TYPE.PUSH &&
    (record.frame.metadata.resource as { kind?: number } | undefined)?.kind === RELAY_KIND.TERMINAL_CELLS;
}
export function isFontTraffic(record: WireRecord): boolean {
  const ref = record.frame.metadata.resource as { key?: string } | undefined;
  return record.frame.codec === RELAY_CODEC.FONT3 || ref?.key === "font/19" || record.frame.metadata.op === RELAY_OP.RESOURCE_INVALIDATE;
}
export function isHistoryTraffic(record: WireRecord): boolean {
  return (record.frame.metadata.resource as { rendition?: string } | undefined)?.rendition === "term-history-v1";
}
export function isCommittedPrivateResponse(frame: RelayDecodedFrame, op: string): boolean {
  return frame.type === RELAY_TYPE.RESPONSE && frame.metadata.op === op && frame.metadata.status === RELAY_STATUS.OK && frame.metadata.final === true;
}
export const eventBytes = (events: readonly TermChannelEvent[]) => events.filter((event): event is Extract<HostLine, { t: "grid" }> => event.t === "grid").map(jsonBytes);
