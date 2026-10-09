export type TermTransport = "relay" | "offload";

export interface TermTransportArguments {
  transport: TermTransport;
  rest: string[];
}

export const termTransportEntry = (transport: TermTransport): string =>
  transport === "relay" ? "app/main.tsx" : "app/main.offload.tsx";

/** Remove Pocket Term's transport choice before forwarding the remaining
 * arguments to the shell or the PocketJS build. Conflicting choices are an
 * operator error; selecting a transport never falls through to the other. */
export function parseTermTransportArguments(
  args: readonly string[],
  fallback: TermTransport = "relay",
): TermTransportArguments {
  let transport: TermTransport | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    const selected = arg === "--relay" ? "relay" : arg === "--offload" ? "offload" : undefined;
    if (!selected) { rest.push(arg); continue; }
    if (transport && transport !== selected) throw new Error("Choose exactly one Pocket Term transport: --relay or --offload");
    transport = selected;
  }
  return { transport: transport ?? fallback, rest };
}
