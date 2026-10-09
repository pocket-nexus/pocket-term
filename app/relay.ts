import { RelayEndpoint, type RelayPrivateCall } from "@pocketjs/framework/relay/endpoint";
import { attachRelaySession, relayChannel, type RelayChannel } from "@pocketjs/framework/relay/channel";
import { RELAY_CODEC, RELAY_DELIVERY, RELAY_EFFECT, RELAY_ERROR } from "@pocketjs/framework/relay/spec";
import type { RelayRandomBytes, RelayScheduler, RelayTransportAdapter } from "@pocketjs/framework/relay/session";
import type { HistoryBatchReply, HistoryBatchRequest } from "../shared/history.ts";
import {
  TERM_DEVICE_REPLICA, TERM_PRIVATE_OPS, TERM_PROFILE, TERM_RELAY, TERM_RESOURCE_FORMS,
  decodeRelayGrid, fontRef, gridRef, historyRef, inputOp, inputOpId,
  parseJsonBytes, replicaNamespace, sessionNamespace, stateRef, termCapabilities, validInputAck, validateFont3,
  type TermInputValue, type TermRelayState, type TermReceipt,
} from "../shared/relay.ts";
import { LIMITS, type InputCommand } from "../shared/exchange.ts";
import type { ClientLine } from "../shared/protocol.ts";
import type { TermChannel, TermChannelEvent } from "./channel.ts";

export interface TermRelayClientOptions {
  transport: RelayTransportAdapter;
  channel?: RelayChannel;
  replica: string;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
}

const TRANSIENT = new Set([RELAY_ERROR.BUSY, "BAD_STATE", "NOT_READY"]);
const resultError = (result: { ok: false; error: unknown }) =>
  String((result.error as { code?: string; message?: string })?.message ?? (result.error as { code?: string })?.code ?? result.error).slice(0, 120);

/** Guest adapter with the same frame-driven surface as the legacy offload
 * channel. Relay resources carry output; profile requests carry commands. */
export function createTermRelayChannel(options: TermRelayClientOptions): TermChannel & {
  endpoint: RelayEndpoint;
  stats(): Record<string, number | string>;
  connect(): void;
  disconnect(reason: string): void;
  handleRecord(record: Uint8Array): void;
  step(): void;
} {
  const ns = replicaNamespace(options.replica);
  let ready = false, generation = 0, stream = 0, opening = false, epoch = "";
  let openBlocked = false, connecting = false, stateOpening = false, gridOpening = false;
  let rotating = false, rotateBeforeNext = true, mutationCount = 0;
  let authority: string = TERM_RELAY.authority;
  let nextId = 1, input: RelayPrivateCall<TermInputValue> | undefined, retry = 0, error = "";
  type InputWork = { opName: string; expected: TermReceipt; batch: InputCommand[]; durable: boolean };
  let activeInput: InputWork | undefined, retryInput: InputWork | undefined, uncertain: InputWork | undefined;
  let reconciling = false, inputBlocked = false;
  let stateSub = 0, gridSub = 0, gridBoot = "", gridSid = -1, gridGen = -1;
  let lastHello: ClientLine | undefined, lastState: TermRelayState | undefined;
  const commands: InputCommand[] = [], incoming: TermChannelEvent[] = [], fontHeld = new Map<number, number>(), fontPending = new Set<string>();
  const counters = { sessions: 0, opens: 0, requests: 0, statuses: 0, subscriptions: 0, grids: 0, fonts: 0, historyGets: 0, errors: 0 };
  const transport: RelayTransportAdapter = { peer: options.transport.peer, trySend: bytes => options.transport.trySend(bytes) };
  const endpoint = new RelayEndpoint({
    role: "guest", transport, local: termCapabilities(), privateOps: TERM_PRIVATE_OPS, resourceForms: TERM_RESOURCE_FORMS,
    requestReserve: 2, scheduler: options.scheduler, randomBytes: options.randomBytes,
    pingIntervalMs: options.pingIntervalMs, stallMs: options.stallMs, retryMs: options.retryMs,
    hooks: {
      onPhase(phase, detail) {
        if (phase === "ready") { ready = true; generation++; openBlocked = false; counters.sessions++; openReplica(); }
        else if (phase === "closed" || phase === "idle") {
          generation++; suspendInput();
          ready = false; stream = 0; opening = connecting = stateOpening = gridOpening = false;
          stateSub = gridSub = 0; gridBoot = ""; gridSid = gridGen = -1;
          epoch = ""; rotating = false; reconciling = false; fontHeld.clear(); fontPending.clear();
          if (detail?.reason) error = detail.reason.slice(0, 120);
        }
      },
      onStreamReset(s) { if (s === stream) {
        generation++; suspendInput();
        stream = 0; epoch = ""; opening = connecting = stateOpening = gridOpening = false; stateSub = gridSub = 0;
        gridBoot = ""; gridSid = gridGen = -1; rotating = false; reconciling = false; fontHeld.clear(); fontPending.clear();
      } },
      onProtocolError(code, detail) { counters.errors++; error = `${code}: ${detail}`.slice(0, 120); },
    },
  });

  function suspendInput() {
    if (activeInput) {
      if (activeInput.durable) uncertain ??= activeInput;
      else retryInput ??= activeInput;
    }
    input = undefined; activeInput = undefined;
  }

  function openReplica() {
    if (!ready || stream || opening || openBlocked || retry) return;
    opening = true; const fence = generation; counters.opens++;
    endpoint.open({ app: "term", namespace: ns, profile: TERM_PROFILE }).then(opened => {
      if (!ready || fence !== generation) return;
      stream = opened.stream; subscribeState(); connectReplica();
    }, cause => {
      const code = String((cause as { message?: string })?.message ?? cause);
      if (TRANSIENT.has(code)) retry = 2;
      else { openBlocked = true; error = `Relay open: ${code}`.slice(0, 120); }
    }).finally(() => { if (fence === generation) opening = false; });
  }

  function subscribeState() {
    if (!stream || stateSub || stateOpening || retry) return;
    stateOpening = true; const fence = generation, targetStream = stream;
    const started = endpoint.subscribe(stream, stateRef(ns), RELAY_DELIVERY.LATEST_SNAPSHOT, {
      onObject(object) {
        if (fence !== generation || targetStream !== stream) return;
        try { adoptState(parseJsonBytes<TermRelayState>(object.data)); }
        catch (cause) { counters.errors++; error = String(cause).slice(0, 120); }
      },
      onEnd(cause) { if (fence !== generation || targetStream !== stream) return; stateSub = 0; stateOpening = false; if (cause) { error = String(cause.code).slice(0, 120); retry = 2; } },
    }, result => {
      if (fence !== generation || targetStream !== stream) return;
      stateOpening = false;
      if (result.ok && "value" in result && result.value.subscription) { stateSub = result.value.subscription; counters.subscriptions++; }
      else if (!result.ok) { counters.errors++; error = resultError(result); retry = 2; }
    }, { maxObjectBytes: TERM_RELAY.stateBytes });
    if (!("correlation" in started)) { stateOpening = false; error = `Relay state subscribe: ${started.code}`; retry = 2; }
  }

  function subscribeGrid(boot: string, sid: number, gen: number) {
    if (!stream || sid < 1 || gen < 1 || gridOpening || retry || gridBoot === boot && gridSid === sid && gridGen === gen && gridSub) return;
    if (gridSub > 0) endpoint.unsubscribe(gridSub);
    gridSub = 0; gridBoot = boot; gridSid = sid; gridGen = gen;
    gridOpening = true; const fence = generation, targetStream = stream;
    const gridNs = sessionNamespace(boot, sid);
    const started = endpoint.subscribe(stream, gridRef(gridNs, sid, gen), RELAY_DELIVERY.RELIABLE_DELTA, {
      onObject(object, context) {
        if (fence !== generation || targetStream !== stream || gridSid !== sid || gridGen !== gen) return;
        try {
          const line = decodeRelayGrid(object.data);
          if (line.sid !== sid || line.gen !== gen) throw new Error("Relay grid identity mismatch");
          if (context.resyncRequired && !line.full) { enqueue({ t: "resync" }); return; }
          counters.grids++; incoming.push(line);
        } catch (cause) { counters.errors++; error = String(cause).slice(0, 120); enqueue({ t: "resync" }); }
      },
      onEnd(cause) { if (fence !== generation || targetStream !== stream || gridSid !== sid || gridGen !== gen) return; gridSub = 0; gridOpening = false; if (cause) { error = String(cause.code).slice(0, 120); retry = 2; } },
    }, result => {
      if (fence !== generation || targetStream !== stream || gridSid !== sid || gridGen !== gen) return;
      gridOpening = false;
      if (result.ok && "value" in result && result.value.subscription) { gridSub = result.value.subscription; counters.subscriptions++; }
      else if (!result.ok) { counters.errors++; error = resultError(result); retry = 2; }
    }, { maxObjectBytes: TERM_RELAY.gridBytes });
    if (!("correlation" in started)) { gridOpening = false; error = `Relay grid subscribe: ${started.code}`; retry = 2; }
  }

  function getFont(slot: number, gen: number) {
    const key = `${slot}/${gen}`;
    if (!stream || fontHeld.get(slot) === gen || fontPending.has(key)) return;
    fontPending.add(key);
    const fence = generation, targetStream = stream;
    const started = endpoint.get(stream, fontRef(ns, slot, gen), { accept: [RELAY_CODEC.FONT3], maxObjectBytes: TERM_RELAY.fontBytes }, result => {
      if (fence !== generation || targetStream !== stream) return;
      fontPending.delete(key);
      if (!result.ok || !("value" in result) || "notModified" in result.value) {
        if (!result.ok) { counters.errors++; error = resultError(result); }
        return;
      }
      try {
        validateFont3(result.value.data, slot); fontHeld.set(slot, gen); counters.fonts++;
        incoming.push({ t: "font", slot, gen, data: result.value.data });
      } catch (cause) { counters.errors++; error = String(cause).slice(0, 120); }
    });
    if (!("correlation" in started)) { fontPending.delete(key); error = `Relay font get: ${started.code}`; }
  }

  function adoptState(state: TermRelayState) {
    if (!state || state.proto !== 6 || typeof state.boot !== "string" || !Array.isArray(state.sessions) || !Array.isArray(state.fonts)) {
      throw new Error("Invalid relay terminal state");
    }
    if (lastState && lastState.boot !== state.boot) {
      incoming.push({ t: "transport-reset" }); fontHeld.clear(); fontPending.clear();
      if (gridSub > 0) endpoint.unsubscribe(gridSub); gridSub = 0; gridBoot = ""; gridSid = gridGen = -1;
    }
    incoming.push({ t: "hello", proto: state.proto, name: state.name, ...(state.active >= 0 ? { sid: state.active } : {}) });
    incoming.push({ t: "sessions", list: state.sessions, active: state.active });
    if (state.bell !== (lastState?.bell ?? state.bell) && state.active >= 0) incoming.push({ t: "bell", sid: state.active });
    if (state.grid) subscribeGrid(state.boot, state.grid.sid, state.grid.gen);
    else if (gridSub > 0) { endpoint.unsubscribe(gridSub); gridSub = 0; gridBoot = ""; gridSid = gridGen = -1; }
    for (const font of state.fonts) if (fontHeld.get(font.slot) !== font.gen) getFont(font.slot, font.gen);
    lastState = state;
  }

  function connectReplica() {
    if (!stream || epoch || connecting || retry) return;
    connecting = true; const fence = generation, targetStream = stream;
    const call = endpoint.request(stream, "x.term.connect", {}); counters.requests++;
    void call.then(result => {
      if (fence !== generation || targetStream !== stream) return;
      connecting = false;
      if (!result.ok) { counters.errors++; error = resultError(result); retry = 2; return; }
      const value = result.value as { epoch?: unknown; ack?: unknown; authority?: unknown };
      if (typeof value.epoch !== "string" || !Number.isSafeInteger(value.ack) || typeof value.authority !== "string") { error = "Invalid relay connect reply"; return; }
      epoch = value.epoch; authority = value.authority;
      const ack = value.ack as number;
      if (retryInput && retryInput.expected.epoch !== epoch) {
        retryInput = undefined; commands.length = 0; nextId = ack + 1;
        incoming.push({ t: "transport-reset" }); error = "Mac restarted; pending input discarded";
        if (lastHello) commands.push({ id: nextId++, line: lastHello });
      } else if (!retryInput && !uncertain) {
        // A fresh guest can queue hello after OPEN but before x.term.connect
        // returns. Rebase that unsent work above the durable replica ack so a
        // hot reload cannot collide with an old opId or accept the wrong ack.
        let id = ack + 1;
        for (const command of commands) command.id = id++;
        nextId = id;
      } else nextId = Math.max(nextId, ack + 1);
      if (uncertain) reconcile(uncertain);
      else { if (!retryInput) rotateBeforeNext = true; pumpInput(); }
    });
  }

  function rotateEpoch() {
    if (!stream || !epoch || rotating || input || uncertain || retryInput) return;
    rotating = true; const fence = generation, targetStream = stream, expectedEpoch = epoch;
    counters.statuses++;
    void endpoint.operationEpoch(stream, { ns, action: "advance", expectedEpoch }).then(result => {
      if (fence !== generation || targetStream !== stream) return;
      rotating = false;
      if (!result.ok) { counters.errors++; error = resultError(result); inputBlocked = true; return; }
      epoch = result.value.opEpoch; mutationCount = 0; rotateBeforeNext = false; pumpInput();
    });
  }

  function enqueue(line: ClientLine): number {
    if (commands.length >= LIMITS.commands) { error = "Input queue full; wait for the Mac"; return 0; }
    if (line.t === "hello") lastHello = line;
    const id = nextId++; commands.push({ id, line }); pumpInput(); return id;
  }

  function finishInput(result: Awaited<RelayPrivateCall<TermInputValue>>, work: InputWork, fence: number, call: RelayPrivateCall<TermInputValue>) {
    if (fence !== generation || input !== call) return;
    input = undefined; activeInput = undefined;
    if (!result.ok) {
      if (result.effect === RELAY_EFFECT.UNKNOWN && work.durable) {
        uncertain = work; retryInput = undefined; reconcile(work); return;
      }
      counters.errors++; error = resultError(result);
      const code = String((result.error as { code?: unknown }).code ?? "");
      if (result.effect === RELAY_EFFECT.UNKNOWN || TRANSIENT.has(code) || code === RELAY_ERROR.RESYNC_REQUIRED) { retryInput = work; retry = 2; }
      else inputBlocked = true;
      return;
    }
    if (!validInputAck(result.value, work.expected)) { counters.errors++; error = "Invalid relay input acknowledgement"; inputBlocked = true; return; }
    retryInput = undefined; mutationCount++;
    while (commands[0] && commands[0].id <= result.value.ack) commands.shift();
    error = result.value.error ?? "";
    pumpInput();
  }

  function reconcile(work: InputWork) {
    if (!stream || reconciling) return;
    reconciling = true; const fence = generation, targetStream = stream;
    counters.statuses++;
    void endpoint.operationStatus(stream, { authority, ns, opEpoch: work.expected.epoch, opId: work.expected.opId }).then(result => {
      if (fence !== generation || targetStream !== stream || uncertain !== work) return;
      reconciling = false;
      if (!result.ok) { counters.errors++; error = resultError(result); retry = 2; return; }
      if (result.value.state === "pending" || result.value.state === "unknown") {
        error = "Terminal write outcome unknown; reconcile before retry"; retry = 30; return;
      }
      const receipt = result.value.receipt as TermReceipt | undefined;
      if (result.value.state !== "committed" || !receipt || receipt.epoch !== work.expected.epoch || receipt.opId !== work.expected.opId || receipt.ack !== work.expected.ack) {
        error = "Terminal write was not committed"; inputBlocked = true; return;
      }
      uncertain = undefined;
      mutationCount = TERM_RELAY.rotateAfter;
      while (commands[0] && commands[0].id <= receipt.ack) commands.shift();
      pumpInput();
    });
  }

  function pumpInput() {
    if (!ready || !stream || !epoch || input || uncertain || inputBlocked || retry || !commands.length) return;
    if (!retryInput && (rotateBeforeNext || mutationCount >= TERM_RELAY.rotateAfter)) { rotateEpoch(); return; }
    let work = retryInput;
    if (!work) {
      const opName = inputOp(commands[0].line);
      const durable = opName === "x.term.hello" || opName === "x.term.new" || opName === "x.term.kill";
      const different = commands.findIndex(command => inputOp(command.line) !== opName);
      const limit = !durable ? Math.min(LIMITS.inputBatch, different < 0 ? commands.length : different) : 1;
      const batch = commands.slice(0, Math.max(1, limit));
      work = { opName, durable, batch, expected: { epoch, ack: batch.at(-1)!.id, opId: inputOpId(batch[0].id) } };
    }
    const fence = generation;
    input = endpoint.request(stream, work.opName, { epoch: work.expected.epoch, commands: work.batch },
      { opEpoch: work.expected.epoch, opId: work.expected.opId }) as RelayPrivateCall<TermInputValue>;
    activeInput = work;
    counters.requests++;
    const call = input;
    void call.then(result => finishInput(result, work!, fence, call));
  }

  const historyIO = {
    request(_method: string, payload: string, complete: (result: { ok: true; value: string } | { ok: false; error: unknown }) => void): number {
      if (!stream || !lastState?.boot) return 0;
      let input: HistoryBatchRequest;
      try { input = JSON.parse(payload); } catch { return 0; }
      const started = endpoint.get(stream, historyRef(sessionNamespace(lastState?.boot ?? "", input.sid), input), {
        accept: [RELAY_CODEC.JSON], maxObjectBytes: TERM_RELAY.historyBytes,
        product: { key: "term", value: { sid: input.sid, epoch: input.epoch, rows: input.rows, offset: input.offset } },
      }, result => {
        if (!result.ok || !("value" in result) || "notModified" in result.value) {
          complete(result.ok ? { ok: false, error: "History unexpectedly not modified" } : { ok: false, error: resultError(result) }); return;
        }
        try {
          const page = parseJsonBytes<HistoryBatchReply>(result.value.data);
          complete({ ok: true, value: JSON.stringify(page) });
        } catch (cause) { complete({ ok: false, error: String(cause).slice(0, 120) }); }
      });
      if (!("correlation" in started)) return 0;
      counters.historyGets++; return started.correlation;
    },
    cancel(id: number) { endpoint.cancel(id, "history view"); },
  };

  const channel: TermChannel & { endpoint: RelayEndpoint; stats(): Record<string, number | string>; connect(): void; disconnect(reason: string): void; handleRecord(record: Uint8Array): void; step(): void } = {
    endpoint, historyIO,
    open: () => ready && stream > 0, status: () => error, inputPending: () => !!input || rotating || commands.length > 0,
    send: enqueue,
    sendBatch(lines) {
      if (commands.length + lines.length > LIMITS.commands) { error = "Input queue full; wait for the Mac"; return false; }
      for (const line of lines) { if (line.t === "hello") lastHello = line; commands.push({ id: nextId++, line }); }
      pumpInput(); return true;
    },
    poll() { return incoming.splice(0); },
    dispose() { if (stateSub > 0) endpoint.unsubscribe(stateSub); if (gridSub > 0) endpoint.unsubscribe(gridSub); endpoint.close(); commands.length = incoming.length = 0; },
    stats: () => ({ ...counters, phase: endpoint.phase, queued: commands.length, uncertain: uncertain ? 1 : 0 }),
    connect() { if (endpoint.phase === "idle") endpoint.hello(); },
    disconnect(reason) { endpoint.handleDisconnect(reason); },
    handleRecord(record) { endpoint.handleRecord(record); },
    step() {
      if (retry > 0) retry--;
      if (!stream) openReplica();
      if (stream) {
        subscribeState(); if (!epoch) connectReplica(); if (lastState?.grid) subscribeGrid(lastState.boot, lastState.grid.sid, lastState.grid.gen);
        for (const font of lastState?.fonts ?? []) if (fontHeld.get(font.slot) !== font.gen) getFont(font.slot, font.gen);
      }
      if (stream && epoch && uncertain && !retry) reconcile(uncertain); else pumpInput();
      endpoint.flush();
    },
  };
  if (options.channel) attachRelaySession(options.channel, channel);
  return channel;
}

export function connectTermRelay(): TermChannel | null {
  const channel = relayChannel({ id: "companion", grants: ["term"] });
  return channel ? createTermRelayChannel({ transport: channel.transport, channel, replica: TERM_DEVICE_REPLICA }) : null;
}
