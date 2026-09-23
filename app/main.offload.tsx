// @title PocketJS: Pocket Term
import { mount } from "@pocketjs/framework/solid";
import TermApp from "./app.tsx";

// Kept as a separate build entry: selecting the rollback transport is an
// artifact choice, not a probe that can change after the guest starts.
mount(() => <TermApp transport="offload" />);
