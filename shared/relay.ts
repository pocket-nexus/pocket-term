import { RELAY_CODEC, RELAY_KIND, RELAY_OP, type RelayResourceRef, type RelayRxLimits } from "@pocketjs/framework/relay/spec";
import type { RelayPrivateOp, RelayResourceForm } from "@pocketjs/framework/relay/endpoint";
import type { RelayLocalCapabilities } from "@pocketjs/framework/relay/session";
import { decodeHistoryRow, validManifest, type HistoryBatchRequest } from "./history.ts";
import { TERM_APP, TERM_PROTO, type ClientLine, type HostLine, type SessionInfo } from "./protocol.ts";

export const TERM_PROFILE = { name: "term", version: 1 };
/** Stable across guest reloads so an uncertain durable write cannot escape
 * its receipt scope by opening a fresh random namespace. */
export const TERM_DEVICE_REPLICA = "handheld";
export const TERM_RELAY = { port: 8742, authority: "pocket-term", gridBytes: 32768, fontBytes: 196608,
  historyBytes: 131072, stateBytes: 8192, rotateAfter: 48 } as const;
export const TERM_RX: RelayRxLimits = { maxWireBytes: 16384, maxMetaBytes: 8192, windowFrames: 8, windowBytes: 65536,
  maxPending: 8, maxObjectBytes: TERM_RELAY.fontBytes, maxAssemblies: 4, maxScratchBytes: 524288 };
export const termCapabilities = (): RelayLocalCapabilities => ({ app: TERM_APP, versions: [[1, 0]], profiles: [TERM_PROFILE],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON, RELAY_CODEC.FONT3], kinds: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE, RELAY_KIND.EVENT], rxLimits: { ...TERM_RX } });

const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum });
const string = (maxBytes: number, minLength = 0) => ({ type: "string", maxBytes, minLength });
const one = { type: "integer", const: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required });
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, maxItems, minItems });
const pair = { type: "array", items: [integer(1, 32), integer(1, 40)], additionalItems: false, minItems: 2, maxItems: 2 };
const helloLine = object({ t: { type: "string", const: "hello" }, proto: { type: "integer", const: TERM_PROTO },
  cols: integer(20, 200), rows: integer(5, 80), cell: pair, role: { type: "string", enum: ["device", "mirror"] }, want: integer(1), history: one }, ["t", "proto", "cols", "rows"]);
const command = (line: unknown) => object({ id: integer(1), line });
const chLine = object({ t: { type: "string", const: "ch" }, s: string(768) });
const keyLine = object({ t: { type: "string", const: "key" }, k: string(48), ctrl: one, alt: one, shift: one }, ["t", "k"]);
const pasteLine = object({ t: { type: "string", const: "paste" }, s: string(768), phase: { type: "string", enum: ["start", "more", "end", "single"] } });
const attachLine = object({ t: { type: "string", const: "attach" }, sid: integer(1) });
const glyphLine = object({ t: { type: "string", const: "glyphs" }, one: string(1344), two: string(1344), reset: one, more: one }, ["t", "one", "two"]);
const scrollLine = object({ t: { type: "string", const: "scroll" }, d: integer(-2000, 2000) });
const resyncLine = object({ t: { type: "string", const: "resync" } });
const epoch = string(96, 1);
const ack = integer();
const receiptSchema = object({ epoch, ack, opId: { type: "string", pattern: "^[0-9a-f]{32}$" } });
const valueSchema = object({ epoch, ack, receipt: receiptSchema, error: string(160, 1) }, ["epoch", "ack", "receipt"]);
const op = (name: string, recovery: RelayPrivateOp["recovery"], args: Record<string, unknown>, value = valueSchema): RelayPrivateOp => ({
  profile: TERM_PROFILE, name: `x.term.${name}`, direction: "guest-to-provider", recovery,
  ...(recovery === "durable" ? { recoveryOp: RELAY_OP.OPERATION_STATUS } : {}),
  maxWireBytes: 4096, maxObjectBytes: 3072, args, value,
});
export const TERM_PRIVATE_OPS: readonly RelayPrivateOp[] = [
  op("connect", "idempotent", object({}), object({ epoch, ack, authority: string(128, 1), boot: string(32, 1) })),
  op("ch", "epoch", object({ epoch, commands: array(command(chLine), 8, 1) })),
  op("key", "epoch", object({ epoch, commands: array(command(keyLine), 8, 1) })),
  op("paste", "epoch", object({ epoch, commands: array(command(pasteLine), 8, 1) })),
  op("attach", "epoch", object({ epoch, commands: array(command(attachLine), 8, 1) })),
  op("glyphs", "epoch", object({ epoch, commands: array(command(glyphLine), 8, 1) })),
  op("scroll", "epoch", object({ epoch, commands: array(command(scrollLine), 8, 1) })),
  op("resync", "epoch", object({ epoch, commands: array(command(resyncLine), 8, 1) })),
  op("hello", "durable", object({ epoch, commands: array(command(helloLine), 1, 1) })),
  op("new", "durable", object({ epoch, commands: array(command(object({ t: { type: "string", const: "new" } })), 1, 1) })),
  op("kill", "durable", object({ epoch, commands: array(command(object({ t: { type: "string", const: "kill" }, sid: integer(1) })), 1, 1) })),
];
export interface TermReceipt { epoch: string; ack: number; opId: string }
export interface TermInputValue { epoch: string; ack: number; receipt: TermReceipt; error?: string }
export interface TermRelayState {
  boot: string;
  name: string;
  proto: number;
  active: number;
  ack: number;
  bell: number;
  sessions: SessionInfo[];
  fonts: { slot: number; gen: number }[];
  grid?: { sid: number; gen: number };
}
export const TERM_RESOURCE_FORMS: readonly RelayResourceForm[] = [
  { profile: TERM_PROFILE, kind: RELAY_KIND.TERMINAL_CELLS },
  { profile: TERM_PROFILE, kind: RELAY_KIND.FILE, argsKey: "term",
    args: object({ sid: integer(1), epoch, rows: array(integer(), 16, 1), offset: integer(0, 16383) }) },
  { profile: TERM_PROFILE, kind: RELAY_KIND.EVENT, valuePresence: "required", value: object({ boot: string(32, 1), name: string(256),
    proto: integer(), active: integer(-1), ack: integer(), bell: integer(),
    sessions: array(object({ sid: integer(1), title: string(256) }), 32),
    fonts: array(object({ slot: integer(19, 23), gen: integer() }), 5),
    grid: object({ sid: integer(1), gen: integer(1) }) },
    ["boot", "name", "proto", "active", "ack", "bell", "sessions", "fonts"]) },
];
export const replicaNamespace = (replica: string) => `term/replica/${replica}`;
export const sessionNamespace = (boot: string, sid: number) => `term/session/${boot}/${sid}`;
export const stateRef = (ns: string, revision?: string): RelayResourceRef => ({ kind: RELAY_KIND.EVENT, ns, key: "state", rendition: "term-state-v1", ...(revision === undefined ? {} : { revision }) });
export const gridRef = (ns: string, sid: number, gen: number): RelayResourceRef => ({ kind: RELAY_KIND.TERMINAL_CELLS, ns, key: `${sid}/${gen}`, revision: String(gen), rendition: "cells-80x24-v1" });
export const fontRef = (ns: string, slot: number, gen?: number): RelayResourceRef => ({ kind: RELAY_KIND.FILE, ns, key: `font/${slot}`, rendition: "font3-5x10-v1", ...(gen === undefined ? {} : { revision: String(gen) }) });
export const historyRef = (ns: string, input: Pick<HistoryBatchRequest, "sid" | "epoch" | "rows" | "offset">): RelayResourceRef => ({
  kind: RELAY_KIND.FILE, ns, key: `history/${input.sid.toString(36)}/${input.rows.map(row => row.toString(36)).join(".")}/${input.offset.toString(36)}`,
  revision: input.epoch, rendition: "term-history-v1",
});
export const inputOp = (line: ClientLine) => `x.term.${line.t}`;
export const inputOpId = (id: number) => id.toString(16).padStart(32, "0");
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const parseJsonBytes = <T>(data: Uint8Array): T => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as T;

/** Ack is a receipt for this exact batch, never permission to drop future keys. */
export function validInputAck(value: TermInputValue, expected: TermReceipt): boolean {
  return !!value && value.epoch === expected.epoch && value.ack === expected.ack &&
    !!value.receipt && value.receipt.epoch === expected.epoch && value.receipt.ack === expected.ack && value.receipt.opId === expected.opId;
}
export function decodeRelayGrid(data: Uint8Array): Extract<HostLine, { t: "grid" }> {
  const line = parseJsonBytes<Extract<HostLine, { t: "grid" }>>(data);
  const int = (n: unknown, min = 0) => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
  if (!line || Object.keys(line).some(k => !["t", "sid", "gen", "seq", "full", "more", "rows", "cur", "ack", "sb", "history"].includes(k)) ||
    line.t !== "grid" || !int(line.sid, 1) || !int(line.gen, 1) || !int(line.seq) ||
    line.full !== undefined && line.full !== 1 || line.more !== undefined && line.more !== 1 ||
    !Array.isArray(line.rows) || line.rows.length > 24) throw new Error("Invalid relay grid");
  const seen = new Set<number>();
  for (const row of line.rows) {
    if (!Array.isArray(row) || !int(row[0]) || row[0] >= 24 || seen.has(row[0])) throw new Error("Invalid relay row");
    seen.add(row[0]); decodeHistoryRow(JSON.stringify(row.slice(1)));
  }
  if (line.more) {
    if (line.cur !== undefined || line.ack !== undefined || line.history !== undefined) throw new Error("Grid trailer before last chunk");
  } else if (!Array.isArray(line.cur) || line.cur.length !== 3 || !int(line.cur[0]) || line.cur[0] >= 80 || !int(line.cur[1]) || line.cur[1] >= 24 ||
    ![0, 1].includes(line.cur[2]) || !int(line.ack) || line.history && !validManifest(line.history)) throw new Error("Invalid grid trailer");
  return line;
}

/** Resource identities are subordinate to the replica stream even though
 * their public namespace is the durable terminal session identity. */
export function ownsSessionNamespace(streamNs: string, resourceNs: string, boot: string): boolean {
  return /^term\/replica\/[a-zA-Z0-9-]{8,80}$/.test(streamNs) &&
    resourceNs.startsWith(`term/session/${boot}/`) && /^term\/session\/[0-9a-f]{32}\/[1-9][0-9]*$/.test(resourceNs);
}

/** FONT3 is one bounded atlas, including its slot, cmap and alpha plane. */
export function validateFont3(data: Uint8Array, slot: number): void {
  if (data.length < 16 || data.length > TERM_RELAY.fontBytes) throw new Error("Invalid FONT3 size");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength), n = v.getUint16(6, true);
  if (v.getUint32(0, true) !== 0x41464344 || v.getUint16(4, true) !== 3 || slot < 19 || slot > 23 || data[12] !== slot ||
    !n || !data[8] || !data[9] || data[14] !== 1 || 16 + n * 8 + n * data[8] * data[9] !== data.length) throw new Error("Invalid FONT3 atlas");
  let previous = -1;
  for (let i = 0; i < n; i++) {
    const at = 16 + i * 8, cp = v.getUint32(at, true);
    if (cp <= previous || cp > 0x10ffff || v.getUint16(at + 4, true) >= n || !data[at + 6]) throw new Error("Invalid FONT3 cmap");
    previous = cp;
  }
}
