import { expect, test } from "bun:test";
import { RELAY_EFFECT, RELAY_OP, RELAY_STATUS, RELAY_TYPE } from "@pocketjs/framework/relay/spec";
import type { RelayDecodedFrame } from "@pocketjs/framework/relay/frame";
import { TERM_PROTO, type ClientLine, type HostLine } from "../shared/protocol.ts";
import { fontRef, inputOpId, replicaNamespace, sessionNamespace } from "../shared/relay.ts";
import { createOffloadRig, createRelayRig, eventBytes, isCommittedPrivateResponse } from "./relay-rig.ts";

const hello: ClientLine = { t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10], history: 1 };
const equalBytes = (left: Uint8Array[], right: Uint8Array[]) => left.length === right.length && left.every((bytes, i) => Buffer.compare(Buffer.from(bytes), Buffer.from(right[i])) === 0);

async function readyRelay() {
  const rig = createRelayRig();
  await rig.until(() => rig.client.open() && !!rig.terminal());
  rig.client.send(hello);
  await rig.until(() => rig.terminal().ack === 1 && rig.events.filter(event => event.t === "grid").length >= 2);
  return rig;
}

test("relay resources preserve the legacy grid bytes and serve binary FONT3 plus 16-row history", async () => {
  const legacy = createOffloadRig(), relay = createRelayRig();
  try {
    for (let i = 0; i < 4; i++) await legacy.frame();
    legacy.channel.send(hello);
    await legacy.until(() => legacy.terminal.ack === 1 && legacy.events.filter(event => event.t === "grid").length >= 2);
    await relay.until(() => relay.client.open() && !!relay.terminal()); relay.client.send(hello);
    await relay.until(() => relay.terminal().ack === 1 && relay.events.filter(event => event.t === "grid").length >= 2 && relay.events.some(event => event.t === "font"));

    expect(equalBytes(eventBytes(legacy.events), eventBytes(relay.events))).toBe(true);
    const font = relay.events.find(event => event.t === "font");
    expect(font?.t).toBe("font");
    if (font?.t === "font") {
      expect(font.slot).toBe(19); expect(font.gen).toBe(1);
      expect(new DataView(font.data.buffer, font.data.byteOffset).getUint16(4, true)).toBe(3);
    }
    let history: unknown;
    relay.client.historyIO!.request("term.history.batch", JSON.stringify({ sid: 1, epoch: "history-1", rows: Array.from({ length: 16 }, (_, i) => 1000 + i), offset: 0 }), result => {
      if (result.ok) history = JSON.parse(result.value);
    });
    await relay.until(() => history !== undefined);
    expect((history as { chunks: unknown[] }).chunks).toHaveLength(16);
    expect(JSON.stringify(history)).toContain("history-1000 中");
  } finally { legacy.close(); relay.close(); }
});

test("a delta racing subscription discovery follows the retained full grid", async () => {
  const rig = createRelayRig();
  try {
    await rig.until(() => rig.client.open() && !!rig.terminal());
    rig.client.send(hello);
    // This frame delivers state to the guest, which queues the grid
    // SUBSCRIBE. Send that request without running the product authority's
    // normal pump, then make terminal output arrive in the exact gap that
    // exposed a missing sequence on the real TCP integration test.
    await rig.frame();
    expect(rig.events.filter(event => event.t === "grid")).toHaveLength(0);
    rig.client.step();
    rig.client.send({ t: "ch", s: "raced-delta" });
    await rig.until(() => rig.events.some(event => event.t === "grid" && event.rows.some(row => JSON.stringify(row).includes("raced-delta"))));

    const grids = rig.events.filter((event): event is Extract<HostLine, { t: "grid" }> => event.t === "grid");
    expect(grids.map(line => line.seq)).toEqual([0, 1, 2]);
    expect(grids.slice(0, 2).every(line => line.full === 1)).toBe(true);
    expect(grids[2].full).toBeUndefined();
  } finally { rig.close(); }
});

test("the same terminal output and key sequence produce byte-identical colored and wide-cell grids", async () => {
  const legacy = createOffloadRig(), relay = createRelayRig();
  try {
    for (let i = 0; i < 4; i++) await legacy.frame();
    legacy.channel.send(hello); await legacy.until(() => legacy.terminal.ack === 1 && legacy.events.filter(event => event.t === "grid").length >= 2);
    await relay.until(() => relay.client.open() && !!relay.terminal()); relay.client.send(hello);
    await relay.until(() => relay.terminal().ack === 1 && relay.events.filter(event => event.t === "grid").length >= 2);
    legacy.takeEvents(); relay.takeEvents();
    const sequence: ClientLine[] = [
      { t: "ch", s: "printf 中" },
      { t: "key", k: "Right", ctrl: 1, shift: 1 },
      { t: "paste", s: "wide→", phase: "single" },
      { t: "glyphs", one: "é", two: "中", reset: 1 },
      { t: "resync" },
    ];
    for (let i = 0; i < sequence.length; i++) {
      legacy.channel.send(sequence[i]); relay.client.send(sequence[i]);
      const ack = i + 2; await legacy.until(() => legacy.terminal.ack === ack); await relay.until(() => relay.terminal().ack === ack);
    }
    await legacy.until(() => legacy.events.filter(event => event.t === "grid").length >= 6);
    await relay.until(() => relay.events.filter(event => event.t === "grid").length >= 6);
    const legacyBytes = eventBytes(legacy.events), relayBytes = eventBytes(relay.events);
    expect(legacyBytes).toHaveLength(6); expect(relayBytes).toHaveLength(6); expect(equalBytes(legacyBytes, relayBytes)).toBe(true);
    const joined = relayBytes.map(bytes => new TextDecoder().decode(bytes)).join("\n");
    expect(joined).toContain('[0,"中",5614318,-1,19,2]');
    expect(joined).toContain('[0,"wide span →",16763904,1053980,null,11]');
  } finally { legacy.close(); relay.close(); }
});

test("a full screen, 1024 history rows and one font replacement report both transports' wire cost", async () => {
  const legacy = createOffloadRig(), relay = createRelayRig();
  try {
    for (let i = 0; i < 4; i++) await legacy.frame();
    const legacyScreenAt = legacy.records.length;
    legacy.channel.send(hello);
    await legacy.until(() => legacy.terminal.ack === 1 && legacy.events.filter(event => event.t === "grid").length >= 2);
    await relay.until(() => relay.client.open() && !!relay.terminal()); const relayScreenAt = relay.records.length; relay.client.send(hello);
    await relay.until(() => relay.terminal().ack === 1 && relay.events.filter(event => event.t === "grid").length >= 2 && relay.events.some(event => event.t === "font"));

    const legacyScreen = legacy.metrics(legacyScreenAt);
    const relayScreen = relay.metrics(relayScreenAt);
    expect(equalBytes(eventBytes(legacy.events), eventBytes(relay.events))).toBe(true);

    const historyInput = (start: number) => JSON.stringify({ sid: 1, epoch: "history-1", rows: Array.from({ length: 16 }, (_, i) => start + i), offset: 0 });
    async function readLegacy(start: number) {
      let done = false; legacy.channel.historyIO!.request("term.history.batch", historyInput(start), result => { expect(result.ok).toBe(true); done = true; });
      await legacy.until(() => done);
    }
    async function readRelay(start: number) {
      let done = false; relay.client.historyIO!.request("term.history.batch", historyInput(start), result => { expect(result.ok).toBe(true); done = true; });
      await relay.until(() => done);
    }
    const legacyHistoryAt = legacy.records.length, relayHistoryAt = relay.records.length;
    for (let start = 0; start < 1024; start += 16) { await readLegacy(start); await readRelay(start); }
    const legacyHistory = legacy.metrics(legacyHistoryAt);
    const relayHistory = relay.metrics(relayHistoryAt);

    const legacyFontAt = legacy.records.length, relayFontAt = relay.records.length;
    // 1024 glyphs is the production per-slot cap. This exercises the actual
    // binary-vs-base64 cost rather than a tiny protocol-valid toy atlas.
    legacy.terminal.replaceFontWithGlyphs(2, 1024); relay.terminal().replaceFontWithGlyphs(2, 1024);
    await legacy.until(() => legacy.events.some(event => event.t === "atlas" && event.gen === 2 && !event.more));
    await relay.until(() => relay.events.some(event => event.t === "font" && event.gen === 2));
    const legacyFont = legacy.metrics(legacyFontAt);
    const relayFont = relay.metrics(relayFontAt);

    console.log(`RECEIPT term-wire ${JSON.stringify({ screen: { offload: legacyScreen, relay: relayScreen }, history1024: { offload: legacyHistory, relay: relayHistory }, fontReplace: { offload: legacyFont, relay: relayFont } })}`);
    for (const value of [legacyScreen, relayScreen, legacyHistory, relayHistory, legacyFont, relayFont]) {
      expect(value.frames).toBeGreaterThan(0); expect(value.bytes).toBeGreaterThan(0);
    }
  } finally { legacy.close(); relay.close(); }
});

test("epoch commands deduplicate an identical id and reject a changed payload", async () => {
  const rig = await readyRelay();
  try {
    const stream = rig.stream(), terminal = rig.terminal();
    const helloRequest = rig.records.find(record => record.from === "guest" && record.frame.metadata.op === "x.term.hello")!;
    const epoch = String(helloRequest.frame.metadata.opEpoch);
    const args = { epoch, commands: [{ id: 2, line: { t: "key" as const, k: "Right" } }] };
    const identity = { opEpoch: epoch, opId: inputOpId(2) };
    const first = rig.client.endpoint.request(stream, "x.term.key", args, identity);
    await rig.until(() => terminal.ack === 2); expect((await first).ok).toBe(true);
    const duplicate = rig.client.endpoint.request(stream, "x.term.key", args, identity);
    for (let i = 0; i < 8; i++) await rig.frame();
    expect((await duplicate).ok).toBe(true);
    expect(terminal.applied.filter(item => item.id === 2)).toHaveLength(1);
    expect(rig.authority.counters.duplicates).toBe(0); // duplicate is replayed by O2 before the product handler
    const changed = rig.client.endpoint.request(stream, "x.term.key", { epoch, commands: [{ id: 2, line: { t: "key" as const, k: "Left" } }] }, identity);
    for (let i = 0; i < 8; i++) await rig.frame();
    expect(await changed).toMatchObject({ ok: false, error: { code: "INVALID" }, effect: RELAY_EFFECT.NONE });
    expect(terminal.applied.filter(item => item.id === 2)).toHaveLength(1);
  } finally { rig.close(); }
});

test("overlapping epoch batches stay contiguous and apply each new command once", async () => {
  const rig = await readyRelay();
  try {
    const stream = rig.stream(), terminal = rig.terminal();
    const helloRequest = rig.records.find(record => record.from === "guest" && record.frame.metadata.op === "x.term.hello")!;
    const epoch = String(helloRequest.frame.metadata.opEpoch);
    const lines = ["A", "B", "C"].map(s => ({ t: "ch" as const, s }));
    const first = rig.client.endpoint.request(stream, "x.term.ch", { epoch, commands: lines.slice(0, 2).map((line, index) => ({ id: index + 2, line })) },
      { opEpoch: epoch, opId: inputOpId(2) });
    await rig.until(() => terminal.ack === 3); expect((await first).ok).toBe(true);
    const overlap = rig.client.endpoint.request(stream, "x.term.ch", { epoch, commands: lines.map((line, index) => ({ id: index + 2, line })) },
      { opEpoch: epoch, opId: inputOpId(3) });
    await rig.until(() => terminal.ack === 4); expect((await overlap).ok).toBe(true);
    expect(terminal.applied.filter(item => item.line.t === "ch").map(item => item.id)).toEqual([2, 3, 4]);
    const gap = rig.client.endpoint.request(stream, "x.term.ch", { epoch, commands: [{ id: 6, line: { t: "ch", s: "gap" } }] },
      { opEpoch: epoch, opId: inputOpId(6) });
    for (let i = 0; i < 8; i++) await rig.frame();
    expect(await gap).toMatchObject({ ok: false, error: { code: "INVALID" }, effect: RELAY_EFFECT.NONE });
    expect(terminal.ack).toBe(4);
  } finally { rig.close(); }
});

test("a fresh guest rebases queued input above the durable replica ack", async () => {
  const rig = await readyRelay();
  try {
    const terminal = rig.terminal();
    rig.client.send({ t: "key", k: "Right" });
    await rig.until(() => terminal.ack === 2);
    await rig.reloadGuest([hello]);
    await rig.until(() => terminal.ack === 3);
    expect(terminal.applied.map(item => item.id)).toEqual([1, 2, 3]);
    expect(terminal.applied.filter(item => item.line.t === "hello")).toHaveLength(2);
    expect(rig.client.status?.()).toBe("");
  } finally { rig.close(); }
});

test("product input limits reject before a PTY effect is committed", async () => {
  const rig = await readyRelay();
  try {
    const terminal = rig.terminal(), stream = rig.stream();
    const helloRequest = rig.records.find(record => record.from === "guest" && record.frame.metadata.op === "x.term.hello")!;
    const epoch = String(helloRequest.frame.metadata.opEpoch), opId = inputOpId(2);
    const result = rig.client.endpoint.request(stream, "x.term.ch",
      { epoch, commands: [{ id: 2, line: { t: "ch", s: "x".repeat(257) } }] }, { opEpoch: epoch, opId });
    for (let i = 0; i < 8; i++) await rig.frame();
    expect(await result).toMatchObject({ ok: false, error: { code: "INVALID" }, effect: RELAY_EFFECT.NONE });
    expect(terminal.ack).toBe(1);
    const status = await rig.client.endpoint.operationStatus(stream, { authority: "pocket-term", ns: replicaNamespace("rig-replica"), opEpoch: epoch, opId });
    for (let i = 0; i < 8; i++) await rig.frame();
    expect(await status).toMatchObject({ ok: true, value: { state: "rejected" } });
  } finally { rig.close(); }
});

test("lost durable replies reconcile new and kill through operation.status without replay", async () => {
  for (const operation of ["new", "kill"] as const) {
    const rig = await readyRelay();
    try {
      const terminal = rig.terminal();
      if (operation === "kill") { rig.client.send({ t: "new" }); await rig.until(() => terminal.ack === 2 && terminal.sessions.length === 2); }
      const id = operation === "new" ? 2 : 3, beforeSessions = terminal.sessions.length;
      const line: ClientLine = operation === "new" ? { t: "new" } : { t: "kill", sid: terminal.sessions.at(-1)!.sid };
      rig.dropNext(frame => isCommittedPrivateResponse(frame, `x.term.${operation}`));
      rig.client.send(line);
      await rig.until(() => terminal.ack === id);
      expect(terminal.sessions.length).toBe(beforeSessions + (operation === "new" ? 1 : -1));
      const opId = inputOpId(id), sentBefore = rig.records.filter(record => record.from === "guest" && record.frame.metadata.op === `x.term.${operation}`).length;
      await rig.reconnect(); rig.clearDrop();
      await rig.until(() => Number(rig.client.stats().statuses) >= 1 && Number(rig.client.stats().uncertain) === 0);
      const sentAfter = rig.records.filter(record => record.from === "guest" && record.frame.metadata.op === `x.term.${operation}`).length;
      const durableRequest = rig.records.find(record => record.from === "guest" && record.frame.metadata.op === `x.term.${operation}`)!;
      const status = rig.records.find(record => record.from === "guest" && record.frame.metadata.op === RELAY_OP.OPERATION_STATUS && (record.frame.metadata.args as { opId?: string }).opId === opId);
      expect(sentAfter).toBe(sentBefore); expect(terminal.applied.filter(item => item.line.t === operation)).toHaveLength(1);
      expect(status?.frame.metadata.args).toMatchObject({ authority: "pocket-term", ns: replicaNamespace("rig-replica"), opEpoch: durableRequest.frame.metadata.opEpoch, opId });
    } finally { rig.close(); }
  }
});

test("mutating inputAck makes the guest fail closed and retain its input", async () => {
  let mutated = false;
  const rig = createRelayRig({ mutateProvider(frame) {
    if (!mutated && isCommittedPrivateResponse(frame, "x.term.key")) {
      mutated = true; const value = frame.metadata.value as { ack: number; receipt: { ack: number } };
      return { ...frame, metadata: { ...frame.metadata, value: { ...value, ack: value.ack - 1, receipt: { ...value.receipt, ack: value.receipt.ack - 1 } } } };
    }
    return frame;
  } });
  try {
    await rig.until(() => rig.client.open() && !!rig.terminal()); rig.client.send(hello); await rig.until(() => rig.terminal().ack === 1);
    rig.client.send({ t: "key", k: "Enter" }); await rig.until(() => mutated);
    for (let i = 0; i < 8; i++) await rig.frame();
    expect(rig.client.status?.()).toBe("Invalid relay input acknowledgement");
    expect(rig.client.inputPending!()).toBe(true);
    expect(rig.terminal().applied.filter(item => item.line.t === "key")).toHaveLength(1);
  } finally { rig.close(); }
});

test("OPEN grant and session-scoped history identity fail closed", async () => {
  const denied = createRelayRig({ grants: [] });
  try {
    for (let i = 0; i < 30; i++) await denied.frame();
    expect(denied.client.open()).toBe(false); expect(denied.client.status?.()).toContain("UNAUTHORIZED");
  } finally { denied.close(); }

  const rig = await readyRelay();
  try {
    await expect(rig.client.endpoint.open({ app: "term", namespace: replicaNamespace("second-replica"), profile: { name: "term", version: 1 } })).rejects.toThrow("BUSY");
    let result: unknown;
    const ref = { kind: 7, ns: sessionNamespace("ffffffffffffffffffffffffffffffff", 1), key: "history/1/0/0", revision: "history-1", rendition: "term-history-v1" };
    rig.client.endpoint.get(rig.stream(), ref, { accept: [1], maxObjectBytes: 4096, product: { key: "term", value: { sid: 1, epoch: "history-1", rows: [0], offset: 0 } } }, value => result = value);
    await rig.until(() => result !== undefined);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID" } });
  } finally { rig.close(); }
});

test("font replacement invalidates the old revision and refetches the new FONT3 atlas", async () => {
  const rig = await readyRelay();
  try {
    const before = rig.records.length; rig.terminal().replaceFont(2);
    await rig.until(() => rig.events.some(event => event.t === "font" && event.gen === 2));
    const traffic = rig.records.slice(before);
    expect(traffic.some(record => record.frame.type === RELAY_TYPE.INVALIDATE && JSON.stringify(record.frame.metadata.resource) === JSON.stringify(fontRef(replicaNamespace("rig-replica"), 19, 1)))).toBe(true);
    expect(traffic.some(record => record.frame.codec === 0x0201)).toBe(true);
  } finally { rig.close(); }
});
