// How a server-authored catalog row gets its first question onto the glasses.
//
// ADR 0004 measured that the app ignored a `user_question` emitted when a
// server-authored row opened, and concluded such rows could not host a menu.
// ADR 0005 measured *why*: the question must not arrive in the same tick as the
// stream opening, and the stream must first carry something that looks like a
// turn. A `user_prompt` followed by the question one delay later renders and is
// answerable on a physical phone; the same payload sent synchronously is
// dropped, with no error on either side.
//
// Both halves live here because both synthetic rows (the setup wizard and the
// manage row) depend on them and neither can afford to drift. The failure mode
// is a blank row, not an exception — `assertPrimedQuestion` in
// `scripts/test-owned-server.ts` is the only thing that notices.
//
// Only the first question after a stream opens needs this. Answers emit their
// follow-up question synchronously and the app renders those fine.

import { emit } from "./sse.js";

/** The turn-shaped event that has to precede the question. It shows up in the
 *  transcript as an ordinary `user_prompt`, so each row names itself. */
export function primeRow(id: string, text: string): void {
  emit(id, { type: "user_prompt", text });
}

/** Emit `wire` one delay after the stream opened. `live()` is re-checked at fire
 *  time so a row that moved on — a wizard that started its provider, a manage row
 *  mid-delete — does not put a menu on the glasses that nothing will answer. */
export function deferRowQuestion(
  id: string,
  wire: object,
  delayMs: number,
  live: () => boolean,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (live()) emit(id, wire);
  }, delayMs);
  // A question nobody answers must not be why the process cannot exit.
  timer.unref();
  return timer;
}
