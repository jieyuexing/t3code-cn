import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";

/**
 * `grok models` prints the logged-out banner while it refreshes an expired token, and
 * `canRunChildTask` closes on an `unauthenticated` snapshot. After a confirmed login, the
 * first logged-out verdict is held as unconfirmed; a second one in a row stands.
 */
export const makeGrokLoggedOutHold = Effect.gen(function* () {
  const loggedIn = yield* Ref.make(false);
  return Effect.fn("GrokLoggedOutHold.apply")(function* (
    draft: ServerProviderDraft,
  ): Effect.fn.Return<ServerProviderDraft> {
    const hold = yield* Ref.modify(loggedIn, (wasLoggedIn): readonly [boolean, boolean] => {
      switch (draft.auth.status) {
        case "authenticated":
          return [false, true];
        case "unauthenticated":
          return [wasLoggedIn, false];
        default:
          return [false, wasLoggedIn];
      }
    });
    return hold
      ? {
          ...draft,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok login could not be confirmed. Checking again at the next refresh.",
        }
      : draft;
  });
});
