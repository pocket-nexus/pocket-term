import { expect, test } from "bun:test";
import { parseTermTransportArguments, termTransportEntry } from "../shared/transport.ts";
import { replicaNamespace, TERM_DEVICE_REPLICA } from "../shared/relay.ts";

test("transport selection defaults to relay and removes only its own switch", () => {
  expect(parseTermTransportArguments(["--pocket-only", "--relay"])).toEqual({ transport: "relay", rest: ["--pocket-only"] });
  expect(parseTermTransportArguments(["--offload", "--device", "10.0.0.2"])).toEqual({ transport: "offload", rest: ["--device", "10.0.0.2"] });
  expect(parseTermTransportArguments([])).toEqual({ transport: "relay", rest: [] });
  expect(termTransportEntry("relay")).toBe("app/main.tsx");
  expect(termTransportEntry("offload")).toBe("app/main.offload.tsx");
  expect(replicaNamespace(TERM_DEVICE_REPLICA)).toBe("term/replica/handheld");
});

test("conflicting transport switches fail closed", () => {
  expect(() => parseTermTransportArguments(["--relay", "--offload"])).toThrow("Choose exactly one Pocket Term transport");
});
