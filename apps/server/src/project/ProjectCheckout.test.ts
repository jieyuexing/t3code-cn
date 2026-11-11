import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectCheckout from "./ProjectCheckout.ts";

const layer = ProjectCheckout.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-checkout-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layer)("ProjectCheckout", (it) => {
  it.effect("reads HEAD live and flags only changes to tracked files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const checkout = yield* ProjectCheckout.ProjectCheckout;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-project-checkout-" });
      const run = (args: ReadonlyArray<string>) =>
        git.execute({ operation: "ProjectCheckout.test", cwd, args, timeoutMs: 10_000 });
      const write = (name: string, contents: string) =>
        fileSystem.writeFileString(path.join(cwd, name), contents);
      const commit = Effect.fn(function* (message: string) {
        yield* run(["add", "."]);
        yield* run(["commit", "-m", message]);
      });

      assert.strictEqual(yield* checkout.head(cwd), null);
      yield* run(["init"]);
      yield* run(["config", "user.email", "test@test.com"]);
      yield* run(["config", "user.name", "Test"]);
      assert.strictEqual(yield* checkout.head(cwd), null);

      yield* write("a.txt", "one");
      yield* commit("first");
      const first = yield* checkout.head(cwd);
      assert.match(first ?? "", /^[0-9a-f]{40}$/);
      assert.strictEqual(yield* checkout.hasTrackedChanges(cwd), false);

      yield* write("untracked.txt", "new");
      assert.strictEqual(yield* checkout.hasTrackedChanges(cwd), false);

      yield* write("a.txt", "two");
      assert.strictEqual(yield* checkout.hasTrackedChanges(cwd), true);

      yield* commit("second");
      assert.notStrictEqual(yield* checkout.head(cwd), first);
      assert.strictEqual(yield* checkout.hasTrackedChanges(cwd), false);
    }),
  );
});
