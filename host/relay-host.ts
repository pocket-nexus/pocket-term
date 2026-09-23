import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import {
  RelayOperationAuthority, type RelayEndpoint, type RelayIncomingRequest, type RelayOperationStore,
} from "@pocketjs/framework/relay/endpoint";
import type { RelayOpenRequest, RelayPeerContext } from "@pocketjs/framework/relay/session";
import {
  RELAY_CODEC, RELAY_EFFECT, RELAY_ERROR, RELAY_INVALIDATE_SCOPE, RELAY_KIND, type RelayResourceRef,
} from "@pocketjs/framework/relay/spec";
import { serveRelayTcp, type RelayProviderHooks } from "@pocketjs/framework/relay/wire";
import type { HistoryBatchReply, HistoryBatchRequest } from "../shared/history.ts";
import type { InputCommand } from "../shared/exchange.ts";
import { validateClientLine, type ClientLine, type HostLine } from "../shared/protocol.ts";
import {
  TERM_PRIVATE_OPS, TERM_PROFILE, TERM_RELAY, TERM_RESOURCE_FORMS, fontRef, gridRef, historyRef, inputOp,
  jsonBytes, ownsSessionNamespace, sessionNamespace, stateRef, termCapabilities, type TermInputValue, type TermRelayState,
} from "../shared/relay.ts";

export interface TermRelaySink {
  line(line: HostLine): void;
  font(slot: number, gen: number): void;
}

export interface TermRelayReplica {
  readonly ack: number;
  state(): TermRelayState;
  /** Re-publish volatile view state after the relay endpoint is bound. */
  resume(): void;
  apply(line: ClientLine, id: number): void;
  history(input: HistoryBatchRequest): HistoryBatchReply;
  font(slot: number): { gen: number; bytes: Uint8Array } | undefined;
  close(): void;
}

interface Connection {
  peer: RelayPeerContext;
  endpoint?: RelayEndpoint;
  stream: number;
  ns: string;
  replica?: TermRelayReplica;
  closed: boolean;
  stateRevision: number;
  stateDirty: boolean;
  subscriptions: Set<number>;
  snapshots: Map<string, Extract<HostLine, { t: "grid" }>[]>;
  fonts: Map<number, number>;
  bell: number;
  effects?: ({ line: HostLine } | { slot: number; gen: number })[];
}

export interface TermRelayAuthorityOptions {
  store: RelayOperationStore;
  createReplica(ns: string, peer: RelayPeerContext, sink: TermRelaySink): TermRelayReplica;
  log?: (message: string) => void;
}

/** Provider product layer. PTYs stay behind TermRelayReplica; this class owns
 * relay identities, receipts, subscriptions and bounded resource replies. */
export class TermRelayAuthority {
  readonly operations: RelayOperationAuthority;
  private readonly connections = new Set<Connection>();
  private readonly options: TermRelayAuthorityOptions;
  readonly counters = { opens: 0, inputs: 0, duplicates: 0, grids: 0, states: 0, fonts: 0, historyGets: 0, invalidates: 0, errors: 0 };

  constructor(options: TermRelayAuthorityOptions) {
    this.options = options;
    this.operations = new RelayOperationAuthority({ id: TERM_RELAY.authority, store: options.store });
  }

  connection(peer: RelayPeerContext): { hooks: RelayProviderHooks; bind(endpoint: RelayEndpoint): void; close(): void } {
    const connection: Connection = { peer, stream: 0, ns: "", closed: false, stateRevision: 0, stateDirty: true,
      subscriptions: new Set(), snapshots: new Map(), fonts: new Map(), bell: 0 };
    const sink: TermRelaySink = {
      line: line => this.capture(connection, { line }),
      font: (slot, gen) => this.capture(connection, { slot, gen }),
    };
    const hooks: RelayProviderHooks = {
      authorizeOpen: request => this.authorize(request, connection),
      onStreamOpened: opened => {
        connection.stream = opened.stream; connection.ns = opened.namespace; this.counters.opens++;
        try { connection.replica = this.options.createReplica(opened.namespace, peer, sink); }
        catch (cause) {
          this.counters.errors++; this.options.log?.(`${peer.id}: terminal replica unavailable: ${String(cause).slice(0, 120)}`);
          connection.endpoint?.resetStream(opened.stream, "terminal replica unavailable"); return;
        }
        connection.effects = []; connection.replica.resume();
        const effects = connection.effects; connection.effects = undefined;
        for (const event of effects) this.publishEvent(connection, event, false);
        connection.stateDirty = true; this.pump(connection);
      },
      onStreamReset: stream => { if (connection.stream === stream) this.dropReplica(connection); },
      onRequest: request => this.request(connection, request),
      onGet: request => this.get(connection, request),
      onPhase: phase => { if (phase === "closed" || phase === "idle") { connection.closed = true; this.dropReplica(connection); this.connections.delete(connection); } },
      onProtocolError: (code, detail) => { this.counters.errors++; this.options.log?.(`${peer.id}: relay ${code}: ${detail}`); },
    };
    this.connections.add(connection);
    return { hooks, bind: endpoint => { connection.endpoint = endpoint; }, close: () => { connection.closed = true; this.dropReplica(connection); this.connections.delete(connection); connection.endpoint?.close(); } };
  }

  private authorize(request: RelayOpenRequest, connection: Connection): string | null {
    if (request.app !== "term" || !connection.peer.grants.includes("term")) return RELAY_ERROR.UNAUTHORIZED;
    if (connection.stream) return RELAY_ERROR.BUSY;
    if (request.profile.name !== TERM_PROFILE.name || request.profile.version !== TERM_PROFILE.version) return RELAY_ERROR.UNSUPPORTED;
    if (!/^term\/replica\/[a-zA-Z0-9-]{8,80}$/.test(request.namespace)) return RELAY_ERROR.UNAUTHORIZED;
    return null;
  }

  private dropReplica(connection: Connection) {
    connection.replica?.close(); connection.replica = undefined; connection.stream = 0; connection.subscriptions.clear(); connection.snapshots.clear();
  }

  private capture(connection: Connection, event: { line: HostLine } | { slot: number; gen: number }) {
    if (connection.effects) { connection.effects.push(event); return; }
    this.publishEvent(connection, event);
  }

  private publishEvent(connection: Connection, event: { line: HostLine } | { slot: number; gen: number }, flush = true) {
    if ("slot" in event) {
      const previous = connection.fonts.get(event.slot);
      if (previous !== undefined && previous !== event.gen && connection.endpoint && connection.stream) {
        connection.endpoint.invalidate({ stream: connection.stream, scope: RELAY_INVALIDATE_SCOPE.KEY, ref: fontRef(connection.ns, event.slot, previous), reason: "font slot replaced" });
        this.counters.invalidates++;
      }
      connection.fonts.set(event.slot, event.gen);
      connection.stateDirty = true; if (flush) this.pump(connection); return;
    }
    const line = event.line;
    if (line.t === "grid") {
      const key = `${line.sid}/${line.gen}`;
      if (line.full && line.seq === 0) {
        for (const held of connection.snapshots.keys()) if (held.startsWith(`${line.sid}/`)) connection.snapshots.delete(held);
        connection.snapshots.set(key, []);
      }
      if (line.full) connection.snapshots.get(key)?.push(line);
      if (line.full && line.seq === 0) connection.stateDirty = true;
      // SUBSCRIBE is handled by the shared endpoint, so the product notices
      // it from pump(). Admit it against the retained full snapshot before a
      // newly arriving delta is published; otherwise that delta can fall in
      // the interval between subscription acceptance and local discovery.
      if (!line.full) this.pump(connection);
      this.pushGrid(connection, line); this.counters.grids++;
    } else if (line.t !== "atlas") {
      if (line.t === "bell") connection.bell++;
      connection.stateDirty = true;
    }
    if (flush) this.pump(connection);
  }

  private request(connection: Connection, request: RelayIncomingRequest): boolean {
    const endpoint = connection.endpoint, replica = connection.replica;
    if (!endpoint || !replica || request.stream !== connection.stream) return false;
    if (request.op === "x.term.connect") {
      const current = this.operations.epoch(connection.peer.id, { ns: connection.ns, action: "query" });
      if (!current.ok) endpoint.replyError(request, current.code);
      else endpoint.replyValue(request, { epoch: current.value.opEpoch, ack: replica.ack, authority: TERM_RELAY.authority, boot: replica.state().boot });
      return true;
    }
    const args = request.metadata.args as { epoch?: string; commands?: InputCommand[] };
    const operation = request.operation, identity = operation?.identity;
    const commands = Array.isArray(args.commands) ? args.commands : [];
    const first = commands[0]?.id;
    const validSequence = Number.isSafeInteger(first) && first! >= 1 && commands.every((command, index) =>
      Number.isSafeInteger(command.id) && command.id === first! + index && inputOp(command.line) === request.op);
    if (!identity || args.epoch !== identity.opEpoch || !validSequence || (first! > replica.ack + 1)) {
      endpoint.replyError(request, RELAY_ERROR.INVALID, "command sequence or operation mismatch", RELAY_EFFECT.NONE); return true;
    }
    try { for (const command of commands) validateClientLine(command.line); }
    catch (cause) {
      endpoint.replyError(request, RELAY_ERROR.INVALID, String(cause).slice(0, 120), RELAY_EFFECT.NONE); return true;
    }
    const pending = commands.filter(command => command.id > replica.ack);
    const ack = Math.max(replica.ack, commands.at(-1)!.id), receipt = { epoch: identity.opEpoch, ack, opId: identity.opId };
    const value: TermInputValue = { epoch: identity.opEpoch, ack, receipt };
    connection.effects = [];
    const committed = operation!.commit(value, () => { for (const command of pending) replica.apply(command.line, command.id); });
    const effects = connection.effects; connection.effects = undefined;
    if (!committed.ok) {
      effects.length = 0; endpoint.replyError(request, committed.code, committed.code,
        committed.code === RELAY_ERROR.OUTCOME_UNKNOWN ? RELAY_EFFECT.UNKNOWN : RELAY_EFFECT.NONE);
    } else {
      this.counters.inputs += pending.length; this.counters.duplicates += commands.length - pending.length;
      for (const event of effects) this.publishEvent(connection, event, false);
      connection.stateDirty = true; this.pump(connection);
    }
    return true;
  }

  private get(connection: Connection, request: RelayIncomingRequest) {
    const endpoint = connection.endpoint, replica = connection.replica;
    if (!endpoint || !replica || request.stream !== connection.stream) return;
    const ref = request.metadata.resource as RelayResourceRef;
    try {
      if (ref.kind === RELAY_KIND.FILE && /^font\/(19|20|21|22|23)$/.test(ref.key) && ref.rendition === "font3-5x10-v1") {
        const slot = Number(ref.key.slice(5)), font = replica.font(slot);
        if (ref.ns !== connection.ns) { endpoint.replyError(request, RELAY_ERROR.UNAUTHORIZED, "font replica namespace mismatch"); return; }
        if (!font || ref.revision !== String(font.gen)) { endpoint.replyError(request, RELAY_ERROR.NOT_FOUND, "font generation not found"); return; }
        endpoint.replyObject(request, { ref: fontRef(connection.ns, slot, font.gen), codec: RELAY_CODEC.FONT3, data: font.bytes }); this.counters.fonts++; return;
      }
      if (ref.kind === RELAY_KIND.FILE && ref.rendition === "term-history-v1") {
        const args = (request.metadata.args as { term?: HistoryBatchRequest }).term;
        if (!args || !ownsSessionNamespace(connection.ns, ref.ns, replica.state().boot) || ref.revision !== args.epoch || JSON.stringify(historyRef(sessionNamespace(replica.state().boot, args.sid), args)) !== JSON.stringify(ref)) { endpoint.replyError(request, RELAY_ERROR.INVALID, "history identity mismatch"); return; }
        const reply = replica.history(args);
        endpoint.replyObject(request, { ref, codec: RELAY_CODEC.JSON, data: jsonBytes(reply) }); this.counters.historyGets++; return;
      }
      endpoint.replyError(request, RELAY_ERROR.NOT_FOUND, "unknown terminal resource");
    } catch (cause) { endpoint.replyError(request, RELAY_ERROR.INVALID, String(cause).slice(0, 120)); }
  }

  private pushGrid(connection: Connection, line: Extract<HostLine, { t: "grid" }>, subscription?: number) {
    const endpoint = connection.endpoint; if (!endpoint) return;
    const ref = gridRef(sessionNamespace(connection.replica!.state().boot, line.sid), line.sid, line.gen);
    const subscriptions = subscription === undefined
      ? endpoint.authority?.subscriptionsOn(connection.stream).filter(sub => connection.subscriptions.has(sub.id)
        && sub.ref?.kind === RELAY_KIND.TERMINAL_CELLS && JSON.stringify(sub.ref) === JSON.stringify(ref)).map(sub => sub.id) ?? []
      : [subscription];
    for (const id of subscriptions) endpoint.pushObject({ stream: connection.stream, subscription: id, ref, codec: RELAY_CODEC.JSON, data: jsonBytes(line),
      ...(line.full ? {} : { baseRevision: String(line.gen) }) });
  }

  /** Detect newly accepted subscriptions and publish their current snapshot.
   * Called after output and from the daemon's regular flush tick. */
  pump(connection?: Connection) {
    for (const item of connection ? [connection] : this.connections) {
      const endpoint = item.endpoint, replica = item.replica;
      if (!endpoint || !replica || !item.stream || item.closed) continue;
      const active = endpoint.authority?.subscriptionsOn(item.stream) ?? [];
      for (const sub of active) if (!item.subscriptions.has(sub.id)) {
        if (sub.ref?.kind === RELAY_KIND.TERMINAL_CELLS) {
          const [sidText, genText] = sub.ref.key.split("/"), sid = Number(sidText), gen = Number(genText);
          const expected = gridRef(sessionNamespace(replica.state().boot, sid), sid, gen);
          if (!Number.isSafeInteger(sid) || !Number.isSafeInteger(gen) || JSON.stringify(sub.ref) !== JSON.stringify(expected)) {
            endpoint.resetStream(item.stream, "grid session identity mismatch"); continue;
          }
          const snapshot = item.snapshots.get(sub.ref.key) ?? [];
          if (!snapshot.length || snapshot.at(-1)?.more) continue;
          item.subscriptions.add(sub.id);
          for (const line of snapshot) this.pushGrid(item, line, sub.id);
        } else {
          if (!sub.ref || JSON.stringify(sub.ref) !== JSON.stringify(stateRef(item.ns))) {
            endpoint.resetStream(item.stream, "state identity mismatch"); continue;
          }
          item.subscriptions.add(sub.id);
          if (sub.ref?.kind === RELAY_KIND.EVENT && sub.ref.key === "state") item.stateDirty = true;
        }
      }
      for (const id of [...item.subscriptions]) if (!active.some(sub => sub.id === id)) item.subscriptions.delete(id);
      if (item.stateDirty) {
        const data = { ...replica.state(), bell: item.bell }, ref = stateRef(item.ns, String(++item.stateRevision));
        for (const sub of active) if (sub.ref?.kind === RELAY_KIND.EVENT && sub.ref.key === "state") {
          endpoint.pushObject({ stream: item.stream, subscription: sub.id, ref, codec: RELAY_CODEC.JSON, data: jsonBytes(data) });
          this.counters.states++; item.stateDirty = false;
        }
      }
      endpoint.flush();
    }
  }

  close() { for (const connection of [...this.connections]) { connection.closed = true; this.dropReplica(connection); connection.endpoint?.close(); } this.connections.clear(); }
}

/** Same 64-hex preface as the paired offload lane. */
export function authenticateTermKey(socket: Socket, key: string, timeoutMs = 5000): Promise<RelayPeerContext | null> {
  return new Promise(resolve => {
    let buffer = Buffer.alloc(0), done = false;
    const finish = (peer: RelayPeerContext | null) => { if (done) return; done = true; clearTimeout(timer); socket.off("data", onData); resolve(peer); };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 64) return; socket.pause();
      const expected = Buffer.from(key), presented = buffer.subarray(0, 64), rest = buffer.subarray(64);
      const accepted = presented.length === expected.length && timingSafeEqual(presented, expected);
      if (accepted && rest.length) socket.unshift(rest);
      if (accepted) setTimeout(() => { if (!socket.destroyed) socket.resume(); }, 0);
      finish(accepted ? { id: "device:pocket-term", grants: ["term"] } : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs); socket.on("data", onData); socket.once("close", () => finish(null)); socket.once("error", () => finish(null));
  });
}

export async function serveTermRelay(options: TermRelayAuthorityOptions & { key: string; port?: number; host?: string }) {
  const authority = new TermRelayAuthority(options), pending: ReturnType<TermRelayAuthority["connection"]>[] = [];
  const server = await serveRelayTcp({
    port: options.port ?? TERM_RELAY.port, host: options.host ?? "0.0.0.0", local: termCapabilities(), privateOps: TERM_PRIVATE_OPS,
    resourceForms: TERM_RESOURCE_FORMS, operations: authority.operations, authenticate: socket => authenticateTermKey(socket, options.key),
    hooks: peer => { const connection = authority.connection(peer); pending.push(connection); return connection.hooks; },
    onConnection: connection => { pending.shift()?.bind(connection.endpoint); options.log?.(`relay connection from ${connection.peer.id}`); },
  });
  return { authority, port: server.port, close: async () => { authority.close(); await server.close(); } };
}
