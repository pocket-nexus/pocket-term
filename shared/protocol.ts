// shared/protocol.ts — the terminal wire protocol, shared verbatim by the
// guest app (this directory) and the Mac companion daemon (host/serve.ts).
//
// The terminal worker emits bounded JSON lines. Relay carries grid objects,
// resource pages and private input requests; authenticated offload exchanges
// remain the explicit rollback path, and loopback svc serves mirrors.
// The companion holds the PTYs and an
// authoritative terminal state machine per session; the device renders a
// passive cell-grid replica. Attach delivers a full grid snapshot, everything
// after arrives as ordered row diffs — reconnect/resync repeats the snapshot,
// so the device never reconstructs terminal state from history.
//
// One line must stay under the svc poll buffer (spec SVC_POLL_BUF, 8192
// bytes); the host chunks large grid updates across lines (`more: 1` on every
// chunk but the last).

/** The pocket-svc app id (manifest `companions`, PKNT handshake, beacon). */
export const TERM_APP = "term";
export const TERM_PROTO = 6;

/** Keep every emitted line comfortably under SVC_POLL_BUF. */
export const LINE_BUDGET = 6144;

/** Theme defaults, shared so host-resolved inverse video (which swaps
 *  concrete colors) matches what the device paints for -1. 0xRRGGBB. */
export const THEME_FG = 0xd8dee9;
export const THEME_BG = 0x10151c;
export const THEME_CURSOR = 0x9fb6d8;

/** The glyphs a terminal draws its own furniture with. These literals double
 *  as the font-atlas charset: the pass-1 AST scan collects every string
 *  literal's codepoints into the app's baked atlases, so they come from the
 *  device's own monospace face at the size the grid was measured for.
 *
 *  The complete box-drawing and block-element ranges are here on purpose
 *  rather than the handful a demo happens to print. A block element has to
 *  FILL its cell to tile with its neighbours, and the runtime atlases cannot
 *  promise that: they hold a proportional face scaled down until its widest
 *  glyph fits one column, which turns a solid block into a smaller rectangle
 *  and a drawn logo into rubble. Baked at build time in the mono face, they
 *  land on the cell exactly. */
const BOX_DRAWING =
  "─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿";
const BLOCK_ELEMENTS = "▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟";
/** Symbols outside the box/block ranges. Everything here must exist in the
 *  mono face (test/host.test.ts pins that): a codepoint listed as baked
 *  is also a codepoint the companion will not route to a fallback face, so
 *  one the face lacks renders as tofu with no second chance. ⌐ and ✔ were
 *  here and are not in JetBrains Mono — they belong to the chain. */
const TERM_SYMBOLS = "■□▪▫▲►▼◄◆●○∙·•‾¬½¼«»≈≠≤≥±÷×→←↑↓↔⏻…—–‘’“”➜❯❮✗λ";

export const TERM_GLYPHS = `${BOX_DRAWING}${BLOCK_ELEMENTS}${TERM_SYMBOLS}`;

/** One run of same-styled cells: start column, text, fg, bg (0xRRGGBB ints,
 *  -1 = the theme default), an optional font slot — present when the run's
 *  codepoints live in one of the atlases the companion bakes at runtime
 *  rather than in the app's baked mono slot — and the run's width in
 *  columns, which is only sent when it differs from the character count
 *  (a full-width glyph spans two). */
export type Run = [
  col: number,
  text: string,
  fg: number,
  bg: number,
  slot?: number,
  span?: number,
];

/** Columns a run occupies. */
export function runColumns(run: Run): number {
  return run[5] ?? run[1].length;
}

/** Spare font slots (0..18 are the app's baked sizes, MAX_FONT_SLOTS is 24)
 *  carrying atlases for codepoints the build never saw — CJK, and the
 *  symbols a program draws its interface with. The device loads them through
 *  the spec `loadFontAtlas` op, the same reload path the note widget's
 *  runtime glyph coverage uses (docs/WIDGET.md, docs/BACKENDS.md
 *  `text.glyphs.runtime`); here the rasterizing happens on the companion,
 *  because the console has neither a font file nor a rasterizer.
 *
 *  There are several because no single face covers a terminal: the mono face
 *  has ❯ but no CJK, a CJK face has neither ⏺ nor ⎿, and ⏺ has outlines only
 *  in a math face. One slot per face in the companion's fallback chain. */
export const DYNAMIC_SLOTS = [19, 20, 21, 22, 23] as const;

/** Whether a run's font slot is one the companion supplies at runtime. */
export function isDynamicSlot(slot: number | undefined): slot is number {
  return slot !== undefined && slot >= DYNAMIC_SLOTS[0];
}

/** One replaced row: y, then the row's runs (empty = a blank row). */
export type RowUpdate = [y: number, ...runs: Run[]];

/** Cursor: column, row, visible. Hidden while scrolled into history. */
export type Cursor = [x: number, y: number, on: 0 | 1];

export interface SessionInfo {
  sid: number;
  title: string;
}

/** A replica's role. A `device` drives the sessions: its grid sets their
 *  size, and it may open, close and switch between them. A `mirror` is a
 *  window the companion opens beside one session: it types into that session
 *  like any other replica, but it never resizes a PTY and never re-points
 *  itself, so opening one cannot disturb what the console is looking at. */
export type Role = "device" | "mirror";

/** device -> host */
export type ClientLine =
  | {
      t: "hello";
      proto: number;
      cols: number;
      rows: number;
      /** The replica's measured cell box in px, [width, height]. The
       *  companion bakes dynamic glyph advances against it, so a run of them
       *  lands on the same column boundaries as the baked text beside it. */
      cell?: [number, number];
      role?: Role;
      /** Reattach to this session if it still exists (the console remembers
       *  what it was looking at across a reconnect); mirrors pass the one
       *  session they were opened for and follow nothing else. */
      want?: number;
      /** Scroll position stays on this replica; historical rows use a
       * separate reproducible read capability. */
      history?: 1;
    }
  | { t: "new" }
  | { t: "kill"; sid: number }
  | { t: "attach"; sid: number }
  | { t: "ch"; s: string }
  | { t: "paste"; s: string; phase: "start" | "more" | "end" | "single" }
  | { t: "key"; k: string; ctrl?: 1; alt?: 1; shift?: 1 }
  | { t: "scroll"; d: number }
  | { t: "glyphs"; one: string; two: string; reset?: 1; more?: 1 }
  | { t: "resync" };

/** Product-level validation shared by both transports. Relay's negotiated
 * schema bounds UTF-8 bytes; these checks retain the terminal protocol's
 * UTF-16/codepoint limits before an operation can execute a PTY effect. */
export function validateClientLine(line: ClientLine): void {
  if (!line || typeof line !== "object") throw new Error("Invalid terminal command");
  const integer = (n: unknown, min: number, max: number) =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  switch (line.t) {
    case "hello":
      if (line.proto !== TERM_PROTO || !integer(line.cols, 20, 200) || !integer(line.rows, 5, 80) ||
          (line.role !== undefined && line.role !== "device" && line.role !== "mirror") ||
          (line.cell && (!integer(line.cell[0], 1, 32) || !integer(line.cell[1], 1, 40)))) {
        throw new Error("Invalid terminal dimensions");
      }
      return;
    case "ch": case "paste":
      if (typeof line.s !== "string" || line.s.length > 256) throw new Error("Input exceeds budget");
      if (line.t === "paste" && !["start", "more", "end", "single"].includes(line.phase)) throw new Error("Invalid paste phase");
      return;
    case "key":
      if (typeof line.k !== "string" || line.k.length > 16) throw new Error("Invalid key");
      return;
    case "glyphs":
      if (typeof line.one !== "string" || typeof line.two !== "string" || line.one.length + line.two.length > 448 ||
          [...line.one, ...line.two].length > 224) throw new Error("Glyph demand exceeds budget");
      return;
    case "kill": case "attach":
      if (!integer(line.sid, 1, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid session");
      return;
    case "scroll":
      if (!integer(line.d, -2000, 2000)) throw new Error("Invalid scroll");
      return;
    case "new": case "resync": return;
    default: throw new Error("Unknown terminal command");
  }
}

/** host -> device */
export type HostLine =
  | { t: "hello"; proto: number; name: string; sid?: number }
  | { t: "sessions"; list: SessionInfo[]; active: number }
  | {
      /** One chunk of a runtime-baked atlas. `gen` identifies the bake for
       *  that slot (it grows as sessions print new codepoints); chunks of one
       *  gen arrive in order and the device loads the slot when the last one
       *  lands. A device that joins mid-gen discards the partial and waits
       *  for the next complete one. */
      t: "atlas";
      slot: number;
      gen: number;
      seq: number;
      more?: 1;
      /** Base64 of this chunk of the FONT ATLAS blob. */
      b64: string;
    }
  | {
      t: "grid";
      sid: number;
      /** Bumped by attach/resize/resync; a full snapshot starts the gen. */
      gen: number;
      /** Strictly +1 per line within a gen; a gap means dropped lines and
       *  the device asks for a resync. */
      seq: number;
      /** Present on the gen's opening snapshot chunks: every row is (re)sent
       *  and the device drops any local rows the snapshot does not repeat. */
      full?: 1;
      /** More chunks of this update follow; cursor/scrollback land on the
       *  last chunk. */
      more?: 1;
      rows: RowUpdate[];
      cur?: Cursor;
      /** Input accepted before this snapshot; echo confirmation also requires matching cells. */
      ack?: number;
      /** Lines currently scrolled back into history (0 = live bottom). */
      sb?: number;
      history?: import("./history.ts").HistoryManifest;
    }
  | { t: "exit"; sid: number }
  | { t: "bell"; sid: number };

/**
 * Lines the LOCAL host puts into the same svc queue as the companion's.
 *
 * A desktop window gets its keystrokes this way: `hosts/desktop` forwards
 * the window's input as JSON lines in its own dialect, and the replica
 * relays them to the companion, which owns the PTY. So one queue carries two
 * directions of traffic — terminal state arriving from the companion, and
 * input arriving from the machine the window is on — and they are told apart
 * by shape, not by channel.
 *
 * The host's `hello` is not the companion's: it carries the viewport, no
 * `proto`. Discriminating on `proto` is what keeps the two apart.
 */
export type HostInputLine =
  | { t: "transport-reset" }
  | { t: "hello"; w: number; h: number; epoch?: number }
  | { t: "ch"; s: string }
  | { t: "key"; k: string; sh?: boolean; alt?: boolean; ctl?: boolean; cmd?: boolean }
  | { t: "paste"; text: string }
  | { t: "scroll"; dy: number }
  | { t: "resize"; w: number; h: number }
  | { t: "load"; text: string }
  | { t: "mouse"; x: number; y: number; d?: boolean; sh?: boolean }
  | { t: "ime"; s: string; c: number | null };

/** Named keys the host encodes into PTY bytes (host/keys.ts). */
export type KeyName =
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
  | "Insert"
  | "Enter"
  | "Backspace"
  | "Tab"
  | "Escape"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Delete"
  | "Space";
