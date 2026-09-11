/**
 * Rail Harness Developer Console — shared user-cancellation type.
 *
 * Every place that can be interrupted by the user (`ui.js`'s `selectMenu`,
 * `secret-input.js`'s `promptSecret`) rejects with a `UserCancelledError`
 * instead of a plain `Error` tagged with a string code, so every consumer
 * can detect cancellation with `isUserCancelled(err)` — never by comparing
 * a human-facing message. `.code === "CANCELLED"` is kept on every instance
 * for backward compatibility with existing call sites that still check it.
 */

export class UserCancelledError extends Error {
  constructor(message = "Cancelado por el usuario.") {
    super(message);
    this.name = "UserCancelledError";
    this.code = "CANCELLED";
  }
}

/** True for a `UserCancelledError` or any error carrying the same `.code`. */
export function isUserCancelled(err) {
  return err instanceof UserCancelledError || err?.code === "CANCELLED";
}
