import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RelayOperationAuthority } from "@pocketjs/framework/relay/endpoint";
import { RELAY_EFFECT, RELAY_ERROR, RELAY_STATUS } from "@pocketjs/framework/relay/spec";
import { TermOperationJournal } from "../host/relay-journal.ts";
import { TERM_PRIVATE_OPS, TERM_PROFILE } from "../shared/relay.ts";

const definition = (name: string) => TERM_PRIVATE_OPS.find(op => op.name === `x.term.${name}`)!;
const scope = { authority: "pocket-term", writer: "device:test", ns: "term/replica/journal-test" };
const identity = { ...scope, opEpoch: "0000000000000001", opId: "00000000000000000000000000000001" };

test("durable journal persists a committed receipt across authority restart", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pocket-term-journal-")), path = resolve(directory, "operations.json");
  try {
    let applied = 0;
    const first = new RelayOperationAuthority({ id: scope.authority, store: new TermOperationJournal(path) });
    const begun = first.begin(scope.writer, scope.ns, definition("new"), identity.opEpoch, identity.opId, { epoch: identity.opEpoch, commands: [{ id: 1, line: { t: "new" } }] });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    const receipt = { epoch: identity.opEpoch, ack: 1, opId: identity.opId };
    expect(first.finish(begun.value.identity, { op: "x.term.new", status: RELAY_STATUS.OK, final: true, effect: RELAY_EFFECT.COMMITTED, value: { epoch: identity.opEpoch, ack: 1, receipt } }, { apply: () => { applied++; } })).toEqual({ ok: true, value: expect.anything() });
    expect(applied).toBe(1);
    const restarted = new RelayOperationAuthority({ id: scope.authority, store: new TermOperationJournal(path) });
    expect(restarted.status(scope.writer, { authority: identity.authority, ns: identity.ns, opEpoch: identity.opEpoch, opId: identity.opId }, TERM_PROFILE)).toEqual({ ok: true, value: { state: "committed", receipt } });
    expect(readFileSync(path, "utf8")).toContain(identity.opId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a pending journal record becomes unknown after process restart and cannot execute", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "pocket-term-journal-")), path = resolve(directory, "operations.json");
  try {
    const first = new RelayOperationAuthority({ id: scope.authority, store: new TermOperationJournal(path) });
    expect(first.begin(scope.writer, scope.ns, definition("kill"), identity.opEpoch, identity.opId, { epoch: identity.opEpoch, commands: [{ id: 1, line: { t: "kill", sid: 1 } }] }).ok).toBe(true);
    const restarted = new RelayOperationAuthority({ id: scope.authority, store: new TermOperationJournal(path) });
    expect(restarted.status(scope.writer, { authority: identity.authority, ns: identity.ns, opEpoch: identity.opEpoch, opId: identity.opId }, TERM_PROFILE)).toEqual({ ok: true, value: { state: "unknown" } });
    expect(restarted.begin(scope.writer, scope.ns, definition("kill"), identity.opEpoch, identity.opId, { epoch: identity.opEpoch, commands: [{ id: 1, line: { t: "kill", sid: 1 } }] })).toMatchObject({ ok: true, value: { fresh: false, record: { state: "unknown", terminal: { effect: RELAY_EFFECT.UNKNOWN, error: { code: RELAY_ERROR.OUTCOME_UNKNOWN } } } } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
