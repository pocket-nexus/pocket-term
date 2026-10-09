import { expect, test } from "bun:test";
import { createHistoryBatchLoader } from "../app/history-batch.ts";
import { historyBatchReply } from "../host/history-batch.ts";
import { fitsRecord } from "../shared/exchange.ts";
import { decodeHistoryRow, HISTORY_BATCH, type HistoryBatchRequest } from "../shared/history.ts";
import { historyThroughput } from "./history-throughput.ts";

function transport() {
  let id = 0;
  const requests: { id: number; input: HistoryBatchRequest; done: (r: any) => void; cancelled: boolean }[] = [];
  const loader = createHistoryBatchLoader({ request(method, raw, done) { expect(method).toBe("term.history.batch"); requests.push({ id: ++id, input: JSON.parse(raw), done, cancelled: false }); return id; },
    cancel(id) { const r = requests.find(r => r.id === id); if (r) r.cancelled = true; } });
  return { loader, requests, answer(index: number, read = (row: number) => JSON.stringify([[0, `row-${row}`, -1, -1]])) {
    const r = requests[index]; r.done({ ok: true, value: JSON.stringify(historyBatchReply(r.input, read)) });
  } };
}

test("sixteen independent row loads use one reply and retain exact identities", () => {
  const t = transport(), values = new Map<number, string>();
  for (let row = 10; row < 26; row++) t.loader.load({ sid: 1, epoch: "a", row }, r => { if (r.ok && "value" in r) values.set(row, r.value); });
  t.loader.step(true); expect(t.requests).toHaveLength(1); t.answer(0);
  expect(values.size).toBe(0); t.loader.publish(); expect(values.size).toBe(8); t.loader.publish();
  expect(values.size).toBe(16); expect(decodeHistoryRow(values.get(25)!)[0][1]).toBe("row-25");
});

test("wire filling handles dense colors, quotes, escapes and surrogate pairs exactly", () => {
  const raw = JSON.stringify(Array.from({ length: 80 }, (_, x) => [x, x % 2 ? "字" : "\\\"😀", x % 2 ? 0xffffff : 0x123456, 0xabcdef, 19, 1]));
  const input = { sid: 1, epoch: "a", rows: [10, 11], offset: 0 }, pieces = new Map<number, string>();
  let requests = 0;
  while (input.rows.length) {
    const p = historyBatchReply(input, () => raw); requests++;
    expect(fitsRecord(JSON.stringify(p), "term.history.batch", true)).toBe(true);
    for (const [row, offset, data, more] of p.chunks) {
      expect(offset).toBe((pieces.get(row) ?? "").length); pieces.set(row, (pieces.get(row) ?? "") + data);
      expect(/[\uD800-\uDBFF]$/.test(data)).toBe(false);
      if (!more) { input.rows.shift(); input.offset = 0; } else input.offset += data.length;
    }
  }
  expect(requests).toBeGreaterThan(2); expect(pieces.get(10)).toBe(raw); expect(pieces.get(11)).toBe(raw);
});

test("record boundaries reserve the longer final-fragment flag", () => {
  const raw = '"'.repeat(1003);
  expect(fitsRecord(JSON.stringify({ epoch: "eee", chunks: [[0, 0, raw, false]] }), "term.history.batch", true)).toBe(false);
  const p = historyBatchReply({ sid: 1, epoch: "eee", rows: [0], offset: 0 }, () => raw);
  expect(p.chunks[0][3]).toBe(true);
  expect(fitsRecord(JSON.stringify(p), "term.history.batch", true)).toBe(true);
});

test("cancelling one in-flight row preserves its peers; cancelling all fences late replies", () => {
  const t = transport(), results: number[] = [], handles: ({ cancel(): void } | false)[] = [];
  for (let row = 0; row < 4; row++) handles.push(t.loader.load({ sid: 1, epoch: "a", row }, () => results.push(row)));
  t.loader.step(true); if (handles[0]) handles[0].cancel(); t.answer(0); t.loader.publish(); expect(results).toEqual([1, 2, 3]);
  const last = t.loader.load({ sid: 2, epoch: "b", row: 9 }, () => results.push(9));
  t.loader.step(true); if (last) last.cancel(); expect(t.requests[1].cancelled).toBe(true); t.answer(1); t.loader.publish(); expect(results).toEqual([1, 2, 3]);
});

test("a malformed batch cannot publish a valid prefix and input pressure pauses starts", () => {
  const t = transport(), successes: number[] = [], errors: unknown[] = [];
  for (let row = 0; row < 2; row++) t.loader.load({ sid: 1, epoch: "a", row }, r => { if (r.ok) successes.push(row); else errors.push(r.error); });
  t.loader.step(false); expect(t.requests).toHaveLength(0); t.loader.step(true);
  t.requests[0].done({ ok: true, value: JSON.stringify({ epoch: "a", chunks: [[0, 0, "[]", false], [99, 0, "[]", false]] }) });
  expect(successes).toEqual([]); expect(errors).toHaveLength(2);
});

test("dense rows obey a per-frame decode budget and completed rows remain cancellable", () => {
  const t = transport(), delivered: number[] = [];
  const raw = JSON.stringify(Array.from({ length: 80 }, (_, x) => [x, "X", 0xffffff, 0xabcdef]));
  const handles = Array.from({ length: 4 }, (_, row) => t.loader.load({ sid: 1, epoch: "a", row }, r => { if (r.ok) delivered.push(row); }));
  t.loader.step(true);
  for (let n = 0; n < t.requests.length; n++) { t.answer(n, () => raw); t.loader.step(true); }
  expect(delivered).toEqual([]);
  const last = handles[3]; if (last) last.cancel();
  t.loader.publish(); expect(delivered.length).toBe(Math.min(3, Math.floor(HISTORY_BATCH.materializeChars / raw.length)));
  for (let n = 0; n < 4; n++) t.loader.publish(); expect(delivered).toEqual([0, 1, 2]);
});

test("cold viewport fills in bounded batches under the actual one-reply-per-frame pump", () => {
  for (const fps of [60, 20]) {
    const r = historyThroughput(undefined, fps);
    expect(r.readyRows).toBe(26); expect(r.fullMs).toBeLessThanOrEqual(650);
    expect(r.maxRowsPerReply).toBeGreaterThan(8); expect(r.maxPublished).toBe(HISTORY_BATCH.materializeRows);
    expect(r.historyRequests).toBeLessThanOrEqual(8);
  }
  const colored = historyThroughput(undefined, 60, true);
  expect(colored.readyRows).toBe(26); expect(colored.fullMs).toBeLessThan(8000);
});
