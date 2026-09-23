import type { ClientLine, HostInputLine, HostLine } from "../shared/protocol.ts";

export type TermChannelEvent = HostLine | HostInputLine | { t: "font"; slot: number; gen: number; data: Uint8Array };

export interface TermChannel {
  historyIO?: import("./history.ts").HistoryIO;
  /** Non-blocking transport probe — call once per frame; false while the
   *  companion is still being discovered (the app supplies the cadence). */
  open(): boolean;
  /** Drain and parse this frame's lines (call once per frame). The queue
   *  carries the companion's terminal state and, on a desktop host, the
   *  window's own input — see HostInputLine. */
  poll(): TermChannelEvent[];
  send(line: ClientLine): number | void;
  inputPending?(): boolean;
  sendBatch?(lines: ClientLine[]): boolean;
  status?(): string;
  dispose?(): void;
  /** Relay retries bounded send work at the frame edge; legacy offload has no step. */
  step?(): void;
}
