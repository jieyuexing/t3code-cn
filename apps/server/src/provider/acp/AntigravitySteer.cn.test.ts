import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { watchAntigravitySteerDelivery, wrapAntigravitySteerText } from "./AntigravitySteer.cn.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const TOOL = 8;

describe("wrapAntigravitySteerText", () => {
  it("wraps ordinary steer text and preserves original content and attachment lines", () => {
    const original = "Stop editing foo.ts and check bar.ts instead\n\n[Attached file: /tmp/a.png]";
    const wrapped = wrapAntigravitySteerText(original);
    assert.isTrue(wrapped.startsWith("<user_steer>\n"));
    assert.isTrue(wrapped.endsWith("\n</user_steer>"));
    assert.include(wrapped, original);
  });

  it("leaves empty, whitespace-only, and native slash commands untouched", () => {
    assert.equal(wrapAntigravitySteerText(""), "");
    assert.equal(wrapAntigravitySteerText("   \n\t "), "   \n\t ");
    assert.equal(wrapAntigravitySteerText("/compact"), "/compact");
    assert.equal(wrapAntigravitySteerText("  /help arg"), "  /help arg");
  });
});

describe("watchAntigravitySteerDelivery", () => {
  it.effect("verifies USER_INPUT followed by PLANNER_RESPONSE across steers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      let nextIndex = 0;
      const appendSteps = (steps: ReadonlyArray<number>) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
          for (const type of steps) insert.run(nextIndex++, type, Buffer.from("step"));
        } finally {
          database.close();
        }
      };

      // DB absent before first steer -> baselineIdx = -1, then created with USER_INPUT only -> false.
      const checkBeforeDb = yield* watchAntigravitySteerDelivery(profileDirectory, sessionId);
      assert.isDefined(checkBeforeDb);
      appendSteps([USER_INPUT]);
      assert.equal(yield* checkBeforeDb!(), false);
      appendSteps([PLANNER_RESPONSE]);
      assert.equal(yield* checkBeforeDb!(), true);

      // No USER_INPUT after baseline -> false.
      const checkNoInput = yield* watchAntigravitySteerDelivery(profileDirectory, sessionId);
      assert.isDefined(checkNoInput);
      assert.equal(yield* checkNoInput!(), false);

      // PLANNER_RESPONSE before USER_INPUT belongs to the previous prompt -> still false.
      appendSteps([PLANNER_RESPONSE, USER_INPUT, TOOL]);
      assert.equal(yield* checkNoInput!(), false);

      // Once a PLANNER_RESPONSE lands after that USER_INPUT -> true.
      appendSteps([PLANNER_RESPONSE]);
      assert.equal(yield* checkNoInput!(), true);

      // Two consecutive steers: steer 1 answered, steer 2 still unread.
      const checkSteer1 = yield* watchAntigravitySteerDelivery(profileDirectory, sessionId);
      appendSteps([USER_INPUT]);
      const checkSteer2 = yield* watchAntigravitySteerDelivery(profileDirectory, sessionId);
      appendSteps([PLANNER_RESPONSE]);
      assert.equal(yield* checkSteer1!(), true);
      assert.equal(yield* checkSteer2!(), false);
      appendSteps([USER_INPUT, PLANNER_RESPONSE]);
      assert.equal(yield* checkSteer2!(), true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns undefined conservatively for missing dirs, symlinks, invalid ids, and corrupt dbs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();

        // Missing conversations directory.
        assert.isUndefined(
          yield* watchAntigravitySteerDelivery(profileDirectory, "session-missing-dir"),
        );

        const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
        yield* fs.makeDirectory(conversations, { recursive: true });

        // Invalid sessionId.
        assert.isUndefined(yield* watchAntigravitySteerDelivery(profileDirectory, "../escape"));

        // Symlinked DB.
        const peer = "0d9c2b4e-1111-4222-8333-944455556666";
        const linked = "e6aba774-5472-4277-b6ee-27b2e05570a7";
        const db = new NodeSqlite.DatabaseSync(path.join(conversations, `${peer}.db`));
        db.exec(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
        );
        db.close();
        yield* fs.symlink(
          path.join(conversations, `${peer}.db`),
          path.join(conversations, `${linked}.db`),
        );
        assert.isUndefined(yield* watchAntigravitySteerDelivery(profileDirectory, linked));

        // Corrupt DB before watch -> undefined.
        const corrupt = "corrupt-session-1";
        yield* fs.writeFileString(path.join(conversations, `${corrupt}.db`), "not sqlite");
        assert.isUndefined(yield* watchAntigravitySteerDelivery(profileDirectory, corrupt));

        // DB deleted or corrupted after watch -> check returns undefined conservatively.
        const valid = "valid-session-1";
        const checkValid = yield* watchAntigravitySteerDelivery(profileDirectory, valid);
        assert.isDefined(checkValid);
        assert.isUndefined(yield* checkValid!());
        yield* fs.writeFileString(path.join(conversations, `${valid}.db`), "corrupt");
        assert.isUndefined(yield* checkValid!());
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
