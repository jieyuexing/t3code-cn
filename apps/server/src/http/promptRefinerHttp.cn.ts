import {
  AuthOrchestrationOperateScope,
  ProjectId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import { hasExplicitReplyChoices } from "../orchestration-v2/promptAdvisorService.cn.ts";
import {
  buildPromptAdvisorPrompt,
  builtInAdvisorInstructions,
  decodePromptAdvisorItems,
  type PromptAdvisorItem,
  type PromptAdvisorLiveOptions,
  type PromptAdvisorRuntime,
  previewPromptAdvisorPrompt,
  readPromptAdvisorOutput,
  UNPARSEABLE_OUTPUT_MESSAGE,
} from "../textGeneration/promptAdvisor.cn.ts";
import {
  DEFAULT_PROMPT_ADVISOR_CONFIG,
  decodePromptAdvisorConfig,
  getPromptAdvisorConfig,
  loadPromptAdvisorConfig,
  type PromptAdvisorConfig,
  resolveRoleTarget,
  rolesWithChangedPrompts,
  savePromptAdvisorConfig,
  setPromptAdvisorConfig,
} from "../textGeneration/promptAdvisorConfig.cn.ts";
import {
  describePromptAdvisors,
  releasePromptAdvisorSlots,
  resolvePromptRefiner,
  resolvePromptRole,
  retainPromptAdvisorSlots,
} from "../textGeneration/promptAdvisorRegistry.cn.ts";
import {
  collectWorkspaceFingerprint,
  MODE_DIRECTIVES,
  previewPromptRefinerPrompts,
  PROMPT_REFINE_MODES,
  type PromptRefineMode,
  refinePrompt,
  selectThreadTail,
  threadMessages,
} from "../textGeneration/promptRefiner.cn.ts";

export const PROMPT_REFINE_PATH = "/api/cn/prompt-refine";
export const PROMPT_ADVISOR_CONFIG_PATH = "/api/cn/prompt-advisor/config";
export const PROMPT_ADVISOR_TEST_RUN_PATH = "/api/cn/prompt-advisor/test-run";
export const PROMPT_ADVISOR_CONFIG_FILE = "cn-prompt-advisor.json";

const MAX_DRAFT_CHARS = 20_000;
// A draft of CJK text takes three bytes a character, plus the JSON around it.
const MAX_BODY_BYTES = 128 * 1024;
// A config can hold four long prompts of CJK text.
const MAX_CONFIG_BODY_BYTES = 256 * 1024;
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

const readBody = Effect.fn("PromptRefinerHttp.readBody")(function* (limit: number) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > limit) return Option.none();
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limit)),
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
  const body = Option.flatMap(yield* readBody(MAX_BODY_BYTES), decodeRequest);
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
  const advisor = yield* resolvePromptRefiner;
  if (Option.isNone(advisor)) return refusal(503, "No prompt advisor is available.");

  const root = yield* workspaceRootFor(projectId, threadId);
  const outcome = yield* Effect.all({
    fingerprint: root === undefined ? Effect.succeed("") : collectWorkspaceFingerprint(root),
    threadTail: threadId === undefined ? Effect.succeed([]) : threadTailFor(projection, threadId),
  }).pipe(
    Effect.flatMap((context) =>
      refinePrompt(advisor.value, {
        draft,
        selection,
        mode,
        directive: getPromptAdvisorConfig().refiner.modeOverrides[mode],
        ...context,
      }),
    ),
    Effect.result,
  );
  return outcome._tag === "Success"
    ? HttpServerResponse.jsonUnsafe(outcome.success, { headers: NO_STORE })
    : refusal(502, outcome.failure.detail);
});

const configPayload = Effect.fn("PromptAdvisorConfigHttp.payload")(function* (
  config: PromptAdvisorConfig,
) {
  return {
    config,
    status: yield* describePromptAdvisors(config),
    previews: {
      advisorPromptPreview: previewPromptAdvisorPrompt({
        hasExplicitChoices: false,
        config: config.advisor,
      }),
      advisorExplicitPromptPreview: previewPromptAdvisorPrompt({
        hasExplicitChoices: true,
        config: config.advisor,
      }),
      refinerModePreviews: previewPromptRefinerPrompts(config.refiner.modeOverrides),
      advisorBuiltInInstructions: builtInAdvisorInstructions(
        DEFAULT_PROMPT_ADVISOR_CONFIG.advisor.lenses,
        false,
      ),
      refinerBuiltInDirectives: MODE_DIRECTIVES,
    },
    defaults: DEFAULT_PROMPT_ADVISOR_CONFIG,
  };
});

const PutConfigRequest = Schema.Struct({ config: Schema.Unknown });
const decodePutRequest = Schema.decodeUnknownOption(PutConfigRequest);

const handleGetConfig = Effect.fn("PromptAdvisorConfigHttp.get")(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  return HttpServerResponse.jsonUnsafe(yield* configPayload(getPromptAdvisorConfig()), {
    headers: NO_STORE,
  });
});

const handlePutConfig = Effect.fn("PromptAdvisorConfigHttp.put")(function* (
  filePath: string,
  writing: Semaphore.Semaphore,
) {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const config = Option.flatMap(
    Option.flatMap(yield* readBody(MAX_CONFIG_BODY_BYTES), decodePutRequest),
    ({ config: candidate }) => decodePromptAdvisorConfig(candidate),
  );
  if (Option.isNone(config)) return refusal(400, "The prompt advisor config is not valid.");
  const saved = yield* writing.withPermits(1)(
    savePromptAdvisorConfig(filePath, config.value).pipe(Effect.result),
  );
  if (saved._tag === "Failure") return refusal(500, "Could not save the prompt advisor config.");
  const previous = getPromptAdvisorConfig();
  setPromptAdvisorConfig(config.value);
  yield* retainPromptAdvisorSlots(config.value);
  yield* releasePromptAdvisorSlots(config.value, rolesWithChangedPrompts(previous, config.value));
  return HttpServerResponse.jsonUnsafe(yield* configPayload(config.value), { headers: NO_STORE });
});

const PROMPT_ADVISOR_TEST_SCENARIOS = ["vague", "debugging", "explicit_choices"] as const;

// Representative Chinese exchanges: a claim of done, a patched symptom, and a reply with options.
const TEST_CONVERSATIONS = {
  vague: [
    { role: "user", text: "帮我优化一下登录页" },
    {
      role: "assistant",
      text: "已完成：我把登录页的表单校验、按钮加载态和整体样式都改好了，应该没问题了。",
    },
  ],
  debugging: [
    { role: "user", text: "登录接口的测试挂了，报 401，帮我修一下" },
    {
      role: "assistant",
      text: "我把测试里的断言改成了期望返回 401，现在测试已经通过了。",
    },
  ],
  explicit_choices: [
    { role: "user", text: "缓存方案怎么选？" },
    {
      role: "assistant",
      text: "有两个方案：\n甲：内存缓存，实现简单，但重启后会丢失。\n乙：Redis，数据持久，但要多维护一个依赖。\n\n待你定：选哪个？我推荐乙。",
    },
  ],
} as const;
const TEST_DRAFT = "看一下登录页有什么问题，顺便把它改好";

// `config` is an unsaved draft: the run uses it without saving it or touching the live helpers.
const TestRunRequest = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("advisor"),
    scenario: Schema.Literals(PROMPT_ADVISOR_TEST_SCENARIOS),
    config: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    role: Schema.Literal("refiner"),
    mode: Schema.optional(Schema.Literals(PROMPT_REFINE_MODES)),
    config: Schema.optional(Schema.Unknown),
  }),
]);
const decodeTestRunRequest = Schema.decodeUnknownOption(TestRunRequest);

interface TestRunOutcome {
  readonly items?: ReadonlyArray<PromptAdvisorItem>;
  readonly dropped?: number;
  readonly refined?: string;
  /** What a one-off helper reported; undefined when the run used a warm slot. */
  readonly live?: PromptAdvisorLiveOptions | undefined;
}

const runAdvisorScenario = Effect.fn("PromptAdvisorConfigHttp.runAdvisor")(function* (
  runtime: PromptAdvisorRuntime,
  scenario: (typeof PROMPT_ADVISOR_TEST_SCENARIOS)[number],
  config: PromptAdvisorConfig,
  draft: boolean,
) {
  const messages = TEST_CONVERSATIONS[scenario];
  const input = {
    messages,
    hasExplicitChoices: hasExplicitReplyChoices(messages.at(-1)?.text ?? ""),
  };
  const isolated = draft
    ? yield* runtime.runIsolated(
        buildPromptAdvisorPrompt(messages, {
          hasExplicitChoices: input.hasExplicitChoices,
          config: config.advisor,
        }),
        resolveRoleTarget(config, "advisor"),
      )
    : undefined;
  const reading =
    isolated === undefined
      ? yield* runtime.sampleDetailed(input)
      : readPromptAdvisorOutput(isolated.output, input);
  if (reading._tag === "Unparseable") {
    return yield* new TextGenerationError({
      operation: "samplePromptAdvisor",
      detail: `${UNPARSEABLE_OUTPUT_MESSAGE} It began: ${reading.excerpt || "(empty)"}`,
    });
  }
  return {
    items: decodePromptAdvisorItems(reading.encoded),
    dropped: reading.dropped,
    live: isolated?.live,
  } satisfies TestRunOutcome;
});

const runRefinerSample = Effect.fn("PromptAdvisorConfigHttp.runRefiner")(function* (
  runtime: PromptAdvisorRuntime,
  mode: PromptRefineMode,
  config: PromptAdvisorConfig,
  draft: boolean,
) {
  let live: PromptAdvisorLiveOptions | undefined;
  const target = resolveRoleTarget(config, "refiner");
  const source: PromptAdvisorRuntime = draft
    ? {
        ...runtime,
        runPrompt: (prompt) =>
          Effect.map(runtime.runIsolated(prompt, target), (isolated) => {
            live = isolated.live;
            return isolated.output;
          }),
      }
    : runtime;
  const { refined } = yield* refinePrompt(source, {
    draft: TEST_DRAFT,
    mode,
    directive: config.refiner.modeOverrides[mode],
    fingerprint: "",
    threadTail: [],
  });
  return { refined, live } satisfies TestRunOutcome;
});

const handleTestRun = Effect.fn("PromptAdvisorConfigHttp.testRun")(function* () {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const parsed = Option.flatMap(yield* readBody(MAX_CONFIG_BODY_BYTES), decodeTestRunRequest);
  if (Option.isNone(parsed)) return refusal(400, "The test run request is not valid.");
  const request = parsed.value;
  const saved = getPromptAdvisorConfig();
  const draftConfig =
    request.config === undefined ? Option.none() : decodePromptAdvisorConfig(request.config);
  if (request.config !== undefined && Option.isNone(draftConfig)) {
    return refusal(400, "The draft prompt advisor config is not valid.");
  }
  const draft = Option.isSome(draftConfig);
  const config = Option.getOrElse(draftConfig, () => saved);
  const failure = (statusCode: number, error: string) =>
    Effect.map(describePromptAdvisors(saved), (status) =>
      HttpServerResponse.jsonUnsafe({ error, status }, { status: statusCode, headers: NO_STORE }),
    );
  const resolved = yield* resolvePromptRole(request.role, config);
  if (Option.isNone(resolved)) return yield* failure(503, "No prompt advisor is available.");
  const { runtime, instanceId } = resolved.value;

  const started = yield* Clock.currentTimeMillis;
  const run: Effect.Effect<TestRunOutcome, TextGenerationError> =
    request.role === "advisor"
      ? runAdvisorScenario(runtime, request.scenario, config, draft)
      : runRefinerSample(runtime, request.mode ?? "structured", config, draft);
  const outcome = yield* Effect.result(run);
  if (outcome._tag === "Failure") return yield* failure(502, outcome.failure.detail);
  const { live, ...result } = outcome.success;
  const status = yield* describePromptAdvisors(saved);
  const warm = status[request.role];
  return HttpServerResponse.jsonUnsafe(
    {
      role: request.role,
      durationMs: (yield* Clock.currentTimeMillis) - started,
      draft,
      ran: {
        resolvedInstanceId: instanceId,
        activeModel: live === undefined ? warm.activeModel : live.activeModel,
        activeThinking: live === undefined ? warm.activeThinking : live.activeThinking,
      },
      ...result,
      status,
    },
    { headers: NO_STORE },
  );
});

// The store is read at layer build time so the server provides it beside the other route layers.
// The saved prompt advisor config is loaded here too, so it is in force from server start.
export const promptRefinerRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const filePath = path.join(stateDir, PROMPT_ADVISOR_CONFIG_FILE);
    setPromptAdvisorConfig(yield* loadPromptAdvisorConfig(filePath));
    const writing = yield* Semaphore.make(1);
    return Layer.mergeAll(
      HttpRouter.add("POST", PROMPT_REFINE_PATH, handle(projection)),
      HttpRouter.add("GET", PROMPT_ADVISOR_CONFIG_PATH, handleGetConfig()),
      HttpRouter.add("PUT", PROMPT_ADVISOR_CONFIG_PATH, handlePutConfig(filePath, writing)),
      HttpRouter.add("POST", PROMPT_ADVISOR_TEST_RUN_PATH, handleTestRun()),
    );
  }),
);
