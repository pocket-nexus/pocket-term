import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RELAY_EFFECT, RELAY_ERROR, RELAY_STATUS } from "@pocketjs/framework/relay/spec";
import { RelayOperationStoreError, type RelayOperationNamespace, type RelayOperationScope, type RelayOperationStore } from "@pocketjs/framework/relay/endpoint";

/** Owned exclusively by the Node terminal process. Admission persists a
 * pending intent before a PTY effect. Commit fsyncs its receipt before a
 * response; a process death in between recovers as unknown, never as a new
 * command. PTYs cannot participate in a filesystem transaction, so the
 * journal retains this uncertainty until external evidence reconciles it. */
export class TermOperationJournal implements RelayOperationStore {
  readonly durable = true;
  private states: Record<string, RelayOperationNamespace> = {};
  private active = false;
  private readonly path: string;
  private readonly maxScopes: number;
  constructor(path: string, maxScopes = 64) {
    this.path = path; this.maxScopes = maxScopes;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      this.states = JSON.parse(readFileSync(path, "utf8"));
      if (!this.states || Array.isArray(this.states) || typeof this.states !== "object" || Object.keys(this.states).length > maxScopes) throw new Error("Invalid terminal receipt journal");
      for (const state of Object.values(this.states)) {
        if (!/^[0-9a-f]{16}$/.test(state.opEpoch) || !Array.isArray(state.records) || state.records.length > 64) throw new Error("Invalid terminal receipt scope");
        for (const record of state.records) if (record.state === "pending") {
          record.state = "unknown";
          record.terminal = { op: record.op, status: RELAY_STATUS.ERROR, final: true, effect: RELAY_EFFECT.UNKNOWN,
            error: { code: RELAY_ERROR.OUTCOME_UNKNOWN, message: "Terminal stopped before its receipt was persisted" } };
        }
      }
      this.persist(this.states);
    }
  }
  private persist(states: Record<string, RelayOperationNamespace>) {
    const next = `${this.path}.next`, bytes = JSON.stringify(states);
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
    const fd = openSync(next, "w", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(next, this.path);
    const directory = openSync(dirname(this.path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  transact<T>(scope: Readonly<RelayOperationScope>, update: (current: Readonly<RelayOperationNamespace> | undefined) => { state: RelayOperationNamespace; value: T }): T {
    if (this.active) throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
    const key = JSON.stringify([scope.authority, scope.writer, scope.ns]), current = this.states[key];
    if (!current && Object.keys(this.states).length >= this.maxScopes) throw new RelayOperationStoreError(RELAY_ERROR.BUSY);
    this.active = true;
    try {
      const result = update(current && JSON.parse(JSON.stringify(current)));
      if (JSON.stringify(result.state) !== JSON.stringify(current)) {
        const next = { ...this.states, [key]: result.state };
        this.persist(next); this.states = next;
      }
      return result.value;
    } finally { this.active = false; }
  }
}
