import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { attachRelayChannel, relaySocketChannel } from "@pocketjs/framework/relay/wire";
import { createTermRelayChannel } from "../app/relay.ts";
import { serveTermRelay } from "../host/relay-host.ts";
import { TERM_RELAY } from "../shared/relay.ts";
import { TERM_PROTO, type ClientLine } from "../shared/protocol.ts";
import { FixtureTerminal, RigOperationStore } from "./relay-rig.ts";

const KEY = "cd".repeat(32);
const hello: ClientLine = { t: "hello", proto: TERM_PROTO, cols: 80, rows: 24, cell: [5, 10], history: 1 };

async function socket(port: number): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const value = connect(port, "127.0.0.1", () => resolve(value));
    value.once("error", reject);
  });
}

test("TCP relay authenticates before HELLO and serves grid, FONT3 and history", async () => {
  const terminals = new Map<string, FixtureTerminal>();
  const server = await serveTermRelay({ key: KEY, port: 0, host: "127.0.0.1", store: new RigOperationStore(), createReplica(ns, _peer, sink) {
    let terminal = terminals.get(ns); if (!terminal) terminals.set(ns, terminal = new FixtureTerminal()); return terminal.attach(sink);
  } });
  let device: Socket | undefined;
  try {
    device = await socket(server.port);
    const wire = relaySocketChannel(device, { id: "companion", grants: ["term"] });
    let first = true;
    const client = createTermRelayChannel({ replica: "tcp-test", transport: { peer: wire.peer, trySend(bytes) {
      if (!first) return wire.send(bytes) ? "accepted" : "busy";
      first = false; const combined = new Uint8Array(64 + bytes.length); combined.set(Buffer.from(KEY)); combined.set(bytes, 64);
      return wire.send(combined) ? "accepted" : "busy";
    } }, pingIntervalMs: 1e9, stallMs: 1e9 });
    attachRelayChannel({
      handleRecord: record => client.handleRecord(record),
      handleDisconnect: reason => client.disconnect(reason),
      close: () => client.dispose?.(),
      flush: () => client.step(),
    }, wire, { maxWireBytes: TERM_RELAY.fontBytes });
    client.connect();
    const events: ReturnType<typeof client.poll> = [];
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`relay TCP timeout: ${JSON.stringify(client.stats())}`);
        client.step(); server.authority.pump(); events.push(...client.poll()); await delay(1);
      }
    };
    await until(() => client.open() && terminals.has("term/replica/tcp-test"));
    client.send(hello);
    await until(() => events.some(event => event.t === "grid") && events.some(event => event.t === "font"));
    let history = "";
    client.historyIO!.request("term.history.batch", JSON.stringify({ sid: 1, epoch: "history-1", rows: [1000, 1001], offset: 0 }), result => { if (result.ok) history = result.value; });
    await until(() => history.length > 0);
    expect(history).toContain("history-1000 中");
    expect(server.authority.counters).toMatchObject({ opens: 1, historyGets: 1 });
    client.dispose?.(); device.destroy(); device = undefined;

    const bad = await socket(server.port), closed = new Promise<void>(resolve => bad.once("close", () => resolve()));
    bad.write("ab".repeat(32)); await closed;
    expect(server.authority.counters.opens).toBe(1);
  } finally { device?.destroy(); await server.close(); }
}, 10000);
