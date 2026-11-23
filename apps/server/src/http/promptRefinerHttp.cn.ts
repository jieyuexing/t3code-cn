import { AuthOrchestrationOperateScope, ProjectId, ThreadId } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { resolvePromptAdvisor } from "../textGeneration/promptAdvisorRegistry.cn.ts";
import {
  collectWorkspaceFingerprint,
  PROMPT_REFINE_MODES,
  refinePrompt,
  selectThreadTail,
  threadMessages,
} from "../textGeneration/promptRefiner.cn.ts";

export const PROMPT_REFINE_PATH = "/api/cn/prompt-refine";

const MAX_DRAFT_CHARS = 20_000;
// A draft of CJK text takes three bytes a character, plus the JSON around it.
const MAX_BODY_BYTES = 128 * 1024;
const TAIL_TIMELINE_ITEMS = 24;
const NO_STORE = { "cache-control": "no-store" };

const RefineRequest = Schema.Struct({
  draft: Schema.String,
  selection: Schema.optional(Schema.Struct({ start: Schema.Int, end: Schema.Int })),
  mode: Schema.optional(Schema.Literals(PROMPT_REFINE_MODES)),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRequest = Schema.decodeUnknownOption(RefineRequest);

const refusal = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: NO_STORE });

const readBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > MAX_BODY_BYTES) return Option.none();
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.option,
  );
});

const workspaceRootFor = Effect.fn("PromptRefinerHttp.workspaceRoot")(function* (
  projectId: string | undefined,
  threadId: string | undefined,
) {
  const fromThread =
    threadId === undefined ? undefined : yield* threadWorkspaceRoot(ThreadId.make(threadId));
  if (fromThread !== undefined || projectId === undefined) return fromThread;
  const projects = yield* ProjectService.ProjectService;
  const project = yield* projects
    .getById(ProjectId.make(projectId))
    .pipe(Effect.orElseSucceed(() => Option.none()));
  return Option.getOrUndefined(project)?.workspaceRoot;
});

const threadTailFor = Effect.fn("PromptRefinerHttp.threadTail")(
  function* (
    projection: Pick<ProjectionStore.ProjectionStoreV2Shape, "getTimelinePage">,
    threadId: string,
  ) {
    const page = yield* projection.getTimelinePage(ThreadId.make(threadId), {
      view: "messages",
      beforePosition: Number.POSITIVE_INFINITY,
      limit: TAIL_TIMELINE_ITEMS,
    });
    return selectThreadTail(threadMessages(page.items));
  },
  Effect.orElseSucceed(() => []),
);

const handle = Effect.fn("PromptRefinerHttp.handle")(function* (
  projection: Pick<ProjectionStore.ProjectionStoreV2Shape, "getTimelinePage">,
) {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const body = Option.flatMap(yield* readBody, decodeRequest);
  if (Option.isNone(body)) return refusal(400, "The request body is not valid.");
  const { draft, selection, mode = "structured" } = body.value;
  const projectId = body.value.projectId?.trim() || undefined;
  const threadId = body.value.threadId?.trim() || undefined;
  if (
    draft.trim() === "" ||
    draft.length > MAX_DRAFT_CHARS ||
    (selection !== undefined &&
      !(0 <= selection.start && selection.start <= selection.end && selection.end <= draft.length))
  ) {
    return refusal(400, "The draft or its selection is not valid.");
  }
  const advisor = yield* resolvePromptAdvisor;
  if (Option.isNone(advisor)) return refusal(503, "No prompt advisor is available.");

  const root = yield* workspaceRootFor(projectId, threadId);
  const outcome = yield* Effect.all({
    fingerprint: root === undefined ? Effect.succeed("") : collectWorkspaceFingerprint(root),
    threadTail: threadId === undefined ? Effect.succeed([]) : threadTailFor(projection, threadId),
  }).pipe(
    Effect.flatMap((context) =>
      refinePrompt(advisor.value, { draft, selection, mode, ...context }),
    ),
    Effect.result,
  );
  return outcome._tag === "Success"
    ? HttpServerResponse.jsonUnsafe(outcome.success, { headers: NO_STORE })
    : refusal(502, outcome.failure.detail);
});

// The store is read at layer build time so the server provides it beside the other route layers.
export const promptRefinerRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    return HttpRouter.add("POST", PROMPT_REFINE_PATH, handle(projection));
  }),
);
