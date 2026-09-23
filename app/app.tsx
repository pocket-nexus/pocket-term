// 3DS terminal: the full primary surface is a grid; the auxiliary surface
// owns session navigation, connection status and incremental keyboard input.

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { analogY, rightAnalogX, rightAnalogY, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { TermGrid } from "./grid.tsx";
import { KB_H, Keyboard } from "./keyboard.tsx";
import { connectTermOffload } from "./offload.ts";
import { connectTermRelay } from "./relay.ts";
import { config } from "./config.ts";
import type { TermTransport } from "../shared/transport.ts";
import { FONT_NAMES, loadTerminalFont } from "./font.ts";
import { TERM_LAYOUT, TABS_PER_PAGE, tabPage } from "../shared/layout.ts";
import { createTermStore, type TermStore } from "./store.ts";
import { createCursorStick } from "./stick.ts";
import { TermSettings } from "./settings.tsx";

const TAB_H = 26;
const TAB_W = 72;
/** The trailing "open a session" cell. Narrow, so it reads as sitting beside
 *  the last tab rather than as an empty tab of its own. */
const TAB_NEW_W = 30;
const KB_TOP = 240 - KB_H;


/* Closing a session is a hold, then a slide, then a release — not a tap on a
 * small ×. The panel is resistive and single-contact: an 18 px target inside
 * a 72 px tab was a coin flip, and getting it wrong killed a shell. Holding a
 * tab slides a full-width bar out from under the strip; releasing on the bar
 * closes, releasing anywhere else does not. Nothing about it needs precision
 * in x, and the arming is deliberate. */
const CLOSE_BAR_H = 44;
const CLOSE_HOLD_SECONDS = 0.35;
/** Frames the bar takes to slide in or out. */
const CLOSE_ANIM_FRAMES = 6;

const DPAD_KEYS: readonly [number, "Up" | "Down" | "Left" | "Right"][] = [
  [BTN.UP, "Up"],
  [BTN.DOWN, "Down"],
  [BTN.LEFT, "Left"],
  [BTN.RIGHT, "Right"],
];
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

export default function TermApp(props: { store?: TermStore; initialSettings?: boolean; transport?: TermTransport } = {}) {
  loadTerminalFont();
  const { cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H } = TERM_LAYOUT;
  const transport = props.transport ?? config.transport;
  const store = props.store ?? createTermStore({ cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H] },
    transport === "relay" ? connectTermRelay() : connectTermOffload());
  onCleanup(() => store.dispose());
  const [page, setPage] = createSignal(0);
  const [fontIndex, setFontIndex] = createSignal(0);
  const [settingsOpen, setSettingsOpen] = createSignal(props.initialSettings ?? false);
  const [scrollSpeed, setScrollSpeed] = createSignal(1);
  const [preview, setPreview] = createSignal(true);
  const pageCount = () => Math.max(1, Math.ceil(store.sessions().length / TABS_PER_PAGE));
  const visibleSessions = () => store.sessions().slice(page() * TABS_PER_PAGE, (page() + 1) * TABS_PER_PAGE);
  createEffect(() => {
    const at = store.sessions().findIndex(s => s.sid === store.activeSid());
    setPage(tabPage(at));
  });
  /** The touch keyboard's one-shot Ctrl: armed by its cap, spent by the next
   *  key. Holding L is the other way in, and the cap lights for both. */
  const [ctrlArmed, setCtrlArmed] = createSignal(false);
  const [ctrlHeld, setCtrlHeld] = createSignal(false);
  const ctrlActive = () => ctrlArmed() || ctrlHeld();

  const dpadHeld = new Map<number, number>();
  const cursorStick = createCursorStick();

  let prevButtons = 0, stickVelocity = 0;

  onFrame((buttons) => {
    // Preserve the stick's velocity on release instead of easing through
    // only the final chase gap. Both touch and stick use the same fling.
    const pad = analogY();
    if (!settingsOpen() && Math.abs(pad) > 0.1) {
      const step = Math.sign(pad) * (Math.abs(pad) - 0.1) / 0.9 * 18 * scrollSpeed();
      if (step * stickVelocity < 0) store.history?.stop();
      stickVelocity = step * 60; store.history?.nudge(step);
    } else if (stickVelocity) {
      if (!settingsOpen()) { store.history?.beginDrag(); store.history?.endDrag(stickVelocity); }
      stickVelocity = 0;
    }
    store.frame();

    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    if (settingsOpen()) {
      cursorStick.reset(); dpadHeld.clear();
      if (pressed & BTN.CROSS) setSettingsOpen(false);
      return;
    }
    setCtrlHeld((buttons & BTN.ZL) !== 0);

    let sentThisFrame = false;
    const send = (key: string, ctrl: boolean) => {
      store.sendKey(key, ctrl);
      sentThisFrame = true;
    };

    // The d-pad repeats; everything else fires on its press edge. All of it
    // is level-tested here rather than through onButtonPress so a key can
    // read the modifier held on the same frame.
    for (const [mask, keyName] of DPAD_KEYS) {
      if (buttons & mask) {
        const held = (dpadHeld.get(mask) ?? 0) + 1;
        dpadHeld.set(mask, held);
        if (held === 1 || (held > DPAD_DELAY && (held - DPAD_DELAY) % DPAD_REPEAT === 0)) {
          send(keyName, ctrlActive());
        }
      } else {
        dpadHeld.set(mask, 0);
      }
    }
    for (const [mask, key] of FACE_KEYS) {
      if (pressed & mask) send(key, ctrlActive());
    }
    if (pressed & BTN.START) send("c", true);
    if (pressed & BTN.SELECT) store.newSession();

    const cursorKey = cursorStick.step(rightAnalogX(), rightAnalogY());
    if (cursorKey) send(cursorKey, ctrlActive());

    if (sentThisFrame && ctrlArmed()) setCtrlArmed(false);

    if (pressed & BTN.LTRIGGER) store.attachSibling(-1);
    if (pressed & BTN.RTRIGGER) store.attachSibling(1);

  });

  // Session tab strip on the touch screen: tap a tab to attach, hold one to
  // arm closing it, the trailing + to open one.
  let tabsNode: NodeMirror | undefined;
  let pagesNode: NodeMirror | undefined;
  createGesture({ surface: "auxiliary", region: { node: () => pagesNode }, onTap: contact => {
    const count = pageCount();
    setPage(p => (p + (contact.y < 68 ? -1 : 1) + count) % count);
  } });
  /** The session the close bar is armed for, and how far the bar has slid. */
  const [closingSid, setClosingSid] = createSignal(-1);
  const [closeAnim, setCloseAnim] = createSignal(0);
  const [overClose, setOverClose] = createSignal(false);
  const inCloseBar = (y: number) => y >= TAB_H && y < TAB_H + CLOSE_BAR_H;
  const sessionAt = (x: number) => {
    const list = visibleSessions();
    const index = Math.floor(x / TAB_W);
    return index >= 0 && index < list.length ? list[index] : undefined;
  };

  onFrame(() => {
    // The bar slides both ways, so a cancelled hold retracts rather than
    // vanishing.
    const target = closingSid() >= 0 ? 1 : 0;
    const current = closeAnim();
    if (current === target) return;
    const step = 1 / CLOSE_ANIM_FRAMES;
    setCloseAnim(target > current ? Math.min(1, current + step) : Math.max(0, current - step));
  });

  createGesture({
    surface: "auxiliary",
    region: { node: () => tabsNode },
    longPressSeconds: CLOSE_HOLD_SECONDS,
    onLongPress: (contact) => {
      const session = sessionAt(contact.x);
      if (session) setClosingSid(session.sid);
    },
    onPanMove: (contact) => {
      if (closingSid() >= 0) setOverClose(inCloseBar(contact.y));
    },
    onUp: (contact) => {
      const armed = closingSid();
      if (armed >= 0) {
        if (inCloseBar(contact.y)) store.kill(armed);
        setClosingSid(-1);
        setOverClose(false);
        return;
      }
      // A plain tap: the tabs, then the trailing cell that opens one.
      const list = visibleSessions();
      const session = sessionAt(contact.x);
      if (session) {
        store.attach(session.sid);
        return;
      }
      const trailing = list.length * TAB_W;
      if (contact.x >= trailing && contact.x < trailing + TAB_NEW_W) store.newSession();
    },
    onCancel: () => {
      setClosingSid(-1);
      setOverClose(false);
    },
  });

  const closingTitle = () =>
    store.sessions().find((s) => s.sid === closingSid())?.title ?? "";

  let touchpad: NodeMirror | undefined;
  const [touching, setTouching] = createSignal(false);
  createGesture({ surface: "auxiliary", region: { node: () => touchpad }, axis: "y", panSlop: 2,
    onDown() { if (closingSid() < 0) { setTouching(true); store.history?.beginDrag(); } },
    onPanMove(c) { if (closingSid() < 0) store.history?.drag(-c.fdy * 3 * scrollSpeed()); },
    onPanEnd(c) { setTouching(false); store.history?.endDrag(-c.vy * 3 * scrollSpeed()); },
    onTap() { setTouching(false); store.history?.endDrag(0); },
    onCancel() { setTouching(false); store.history?.stop(); },
  });

  return (
    <>
      <TermGrid
        store={store}
        metrics={{ cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H }}
        badge={`${COLS}×${ROWS}`}
        hint="Connect the paired Mac to continue"
        emptyHint="SELECT opens one · or tap + on the touch screen"
        title="POCKET TERM"
      />

      {/* Touch screen: tabs, status, keyboard. */}
      <AuxiliarySurface>
        <View debugName="TermAux" class="relative w-full h-full bg-[#0d1117] overflow-hidden">
          <View
            debugName="TermTabs"
            ref={(node) => (tabsNode = node)}
            class="absolute left-0 right-0 top-0 flex-row bg-[#141a24]"
            style={{ height: TAB_H }}
          >
            <For each={visibleSessions()}>
              {(session) => (
                <View
                  class={
                    session.sid === store.activeSid()
                      ? "relative h-full items-center justify-center overflow-hidden bg-[#31394a]"
                      : "relative h-full items-center justify-center overflow-hidden"
                  }
                  style={{ width: TAB_W }}
                >
                  <Text
                    class={
                      session.sid === store.activeSid()
                        ? "text-xs text-[#dfe6f2]"
                        : "text-xs text-[#5d708c]"
                    }
                  >
                    {session.title}
                  </Text>
                  <Show when={session.sid === store.activeSid()}>
                    <View class="absolute left-0 right-0 bottom-0 h-[2] bg-[#4c9bf5]" />
                  </Show>
                  {/* The tab being held reads as the source of the bar. */}
                  <Show when={session.sid === closingSid()}>
                    <View class="absolute left-0 right-0 top-0 bottom-0 bg-[#7a2c2c66]" />
                  </Show>
                </View>
              )}
            </For>
            <View class="h-full items-center justify-center" style={{ width: TAB_NEW_W }}>
              <Text class="text-sm text-[#5d708c]">+</Text>
            </View>
          </View>

          <View ref={touchpad} debugName="HistoryTouchpad" class="absolute left-[4] top-[30] h-[76] rounded-[4] border border-[#273345] overflow-hidden" style={{ width: pageCount() > 1 ? 260 : 312, bgColor: touching() ? 0xff30251b : 0xff1b1611 }}>
            <View class="absolute left-[110] top-[34] w-[40] h-[1] bg-[#35475b]" />
            <View class="absolute left-[118] top-[40] w-[24] h-[1] bg-[#35475b]" />
            <View class={store.conn() === "live" ? "absolute right-[7] bottom-[7] w-[3] h-[3] rounded-[2] bg-[#42765a]" : "absolute right-[7] bottom-[7] w-[3] h-[3] rounded-[2] bg-[#bb8041]"} />
          </View>
          <Show when={pageCount() > 1}>
            <View ref={node => pagesNode = node} class="absolute left-[270] top-[30] w-[46] h-[76] rounded-[4] bg-[#141b24]">
              <Text class="absolute left-[16] top-[7] text-lg text-[#9fb6d8]">‹</Text>
              <Text class="absolute left-[16] top-[43] text-lg text-[#9fb6d8]">›</Text>
            </View>
          </Show>

          <Keyboard
            top={KB_TOP}
            onSettings={() => { store.history?.stop(); setSettingsOpen(true); }}
            onChar={(ch) => {
              store.sendText(ch);
              setCtrlArmed(false);
            }}
            onKey={(name, ctrl, alt, shift) => store.sendKey(name, ctrl || ctrlHeld(), alt, shift)}
            ctrlArmed={ctrlActive}
            setCtrlArmed={setCtrlArmed}
          />
          {/* Slides out from under the strip while a tab is held. */}
          <Show when={closeAnim() > 0}>
            <View
              debugName="TabCloseBar"
              class={
                overClose()
                  ? "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#a33a3a]"
                  : "absolute left-0 right-0 flex-row items-center justify-center gap-[6] bg-[#5c2626]"
              }
              style={{
                insetT: TAB_H,
                height: CLOSE_BAR_H,
                translateY: -(1 - closeAnim()) * CLOSE_BAR_H,
                opacity: closeAnim(),
              }}
            >
              <Text class="text-sm text-[#ffdede] font-bold">×</Text>
              <Text class="text-xs text-[#ffdede]">
                {overClose() ? "release to close" : "slide here to close"}
              </Text>
              <Text class="text-xs text-[#e0a0a0]">{closingTitle()}</Text>
            </View>
          </Show>

          <Show when={settingsOpen()}>
            <TermSettings font={fontIndex()} speed={scrollSpeed()} preview={preview()} status={store.conn() === "live" ? store.hostName() : "Waiting for paired Mac"}
              onFont={n => { setFontIndex(n); loadTerminalFont(FONT_NAMES[n]); }}
              onSpeed={setScrollSpeed} onPreview={on => { setPreview(on); store.setPreview(on); }} onClose={() => setSettingsOpen(false)} />
          </Show>
        </View>
      </AuxiliarySurface>
    </>
  );
}

/** Face buttons that send a key, level-tested so a held Ctrl applies. */
const FACE_KEYS: readonly [number, string][] = [
  [BTN.CIRCLE, "Enter"],
  [BTN.CROSS, "Backspace"],
  [BTN.TRIANGLE, "Tab"],
  [BTN.SQUARE, "Space"],
];
