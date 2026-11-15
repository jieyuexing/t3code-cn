import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { NeedsYouThread } from "./needsYou.logic";
import { useNeedsYou } from "./useNeedsYou";

const mocks = vi.hoisted(() => ({
  threads: [] as ReadonlyArray<unknown>,
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.threads,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => mocks.commands[command.label] ?? vi.fn(),
}));

const environmentId = EnvironmentId.make("environment-a");
const TAIL = "environment-data:needs-you:thread-tail";
const TRANSCRIPT = "environment-data:orchestration:thread-transcript";

const thread = (threadId: string): NeedsYouThread => ({
  threadId,
  title: `Thread ${threadId}`,
  status: "done",
  request: null,
  requestId: null,
  lastTurnCompletedAt: "2026-11-11T10:00:00.000Z",
  waitingSince: "2026-11-11T10:00:00.000Z",
});

function Entries() {
  return (
    <ul>
      {useNeedsYou(environmentId).map((entry) => (
        <li key={entry.thread.threadId}>{`${entry.thread.threadId}: ${entry.text}`}</li>
      ))}
    </ul>
  );
}

it("reads a thread's recent window, never its whole transcript", async () => {
  mocks.threads = [thread("long-thread")];
  mocks.commands = {
    [TAIL]: vi.fn(async () => ({
      _tag: "Success",
      value: {
        _tag: "present",
        snapshot: {
          projection: {
            visibleTurnItems: [
              {
                visibility: "inherited",
                item: { type: "assistant_message", text: "## 待你定\n1. 别的线程的事" },
              },
              {
                visibility: "local",
                item: { type: "assistant_message", text: "做完了。\n## 待你定\n1. 要不要合并？" },
              },
            ],
          },
        },
      },
    })),
    [TRANSCRIPT]: vi.fn(async () => {
      throw new Error("the whole transcript was read");
    }),
  };
  await using _screen = await render(<Entries />);
  await expect.element(page.getByText("long-thread: 要不要合并？")).toBeVisible();
  expect(mocks.commands[TAIL]).toHaveBeenCalledTimes(1);
  expect(mocks.commands[TAIL]).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "long-thread" },
  });
  expect(mocks.commands[TRANSCRIPT]).not.toHaveBeenCalled();
});
