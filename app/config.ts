import type { TermTransport } from "../shared/transport.ts";

/** The normal entry is relay-only. The build wrapper selects the separate
 * offload entry when --offload is explicit, so a missing relay lane cannot
 * silently change protocol at runtime. */
export const config: Readonly<{ transport: TermTransport }> = { transport: "relay" };
