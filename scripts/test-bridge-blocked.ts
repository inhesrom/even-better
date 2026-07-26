import assert from "node:assert/strict";
import { test } from "node:test";
import { PaneBridge } from "../src/bridge.js";
import { setMux, type Multiplexer, type PaneInfo, type PaneStatus } from "../src/multiplexer.js";
import { getMessages } from "../src/sse.js";

// A blocked pane must never be left with nothing on the glasses. emitBlockedMenu
// runs only on the edge transition into "awaiting" (its caller is guarded by
// `state !== "awaiting"`), so a bare `return` on a failed screen read stranded
// the session: no permission_request, no user_question, no notification, and
// nothing to re-enter the method. The user saw a frozen session they could not
// answer.

interface WireMessage {
  id: number;
  type?: string;
  title?: string;
  message?: string;
}

function messages(paneId: string): WireMessage[] {
  return getMessages(paneId, 0) as unknown as WireMessage[];
}

/** A mux whose screen reads always fail; everything else is inert. */
function unreadableMux(reads: { count: number }): Multiplexer {
  return {
    name: "fake",
    listPanes: () => Promise.resolve([]),
    watchStatus: (_paneId: string, _onStatus: (s: PaneStatus, session?: string) => void) => ({
      close: () => undefined,
    }),
    read: () => {
      reads.count++;
      return Promise.reject(new Error("pane read failed"));
    },
    send: () => Promise.resolve(),
    sessionId: () => Promise.resolve(undefined),
    exists: () => Promise.resolve(true),
  };
}

const pane = (paneId: string): PaneInfo => ({
  paneId,
  agent: "claude",
  cwd: "/tmp",
  focused: true,
  status: "awaiting",
});

test("a blocked pane whose screen cannot be read still tells the user where the prompt is", async () => {
  const reads = { count: 0 };
  setMux(unreadableMux(reads));
  const bridge = new PaneBridge(pane("w1:unreadable"));
  try {
    bridge.start();
    // 400ms settle + two 500ms retries, plus slack.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const sent = messages("w1:unreadable");
    const notification = sent.find((message) => message.type === "notification");
    assert.ok(notification, `expected a notification, got ${JSON.stringify(sent)}`);
    assert.match(String(notification.message), /respond in the terminal/);
    // It retried rather than giving up on the first failure.
    assert.ok(reads.count >= 2, `expected retries, saw ${reads.count} read attempts`);
  } finally {
    bridge.dispose();
  }
});

test("a blocked pane recovers silently when a retried screen read succeeds", async () => {
  let attempts = 0;
  const screen = ["Do you want to proceed?", "> 1. Yes", "  2. No"].join("\n");
  setMux({
    ...unreadableMux({ count: 0 }),
    read: () => {
      attempts++;
      // Fail the first read, succeed on the retry.
      return attempts === 1 ? Promise.reject(new Error("transient")) : Promise.resolve(screen);
    },
  });
  const bridge = new PaneBridge(pane("w1:recovers"));
  try {
    bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const sent = messages("w1:recovers");
    assert.ok(sent.length > 0, "expected the pane to emit something");
    // The retry produced a screen, so the pane went down the normal
    // menu-handling path — never the "could not be read" fallback. (What that
    // path then makes of a given screen is parse.ts's job; see test-menu.ts.)
    assert.ok(
      !sent.some((message) => /could not be read/.test(String(message.message))),
      `expected recovery, got ${JSON.stringify(sent)}`,
    );
  } finally {
    bridge.dispose();
  }
});
