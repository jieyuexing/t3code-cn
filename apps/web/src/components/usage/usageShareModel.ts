import type { SpeedRanking } from "@t3tools/shared/usageSpeed";

/** The placeholder for a missing dispatch record. */
export const EM_DASH = String.fromCharCode(0x2014);

export type ShareLang = "zh" | "en";

export interface ShareVendor {
  readonly name: string;
  readonly color: string;
}

export interface ShareRow {
  readonly rank: number;
  readonly name: string;
  readonly channel: { readonly label: string; readonly color: string };
  readonly color: string;
  readonly rate: number;
  readonly thin: boolean;
  /** "s/n", or null without a dispatch record. */
  readonly dispatch: string | null;
}

export interface ShareStrings {
  readonly title: string;
  readonly badge: string;
  readonly subtitle: string;
  readonly speedHeader: string;
  readonly dispatchHeader: string;
  readonly thinKey: string | null;
  readonly noDispatchKey: string | null;
  readonly notes: readonly string[];
  readonly brand: string;
}

export interface ShareData {
  readonly lang: ShareLang;
  readonly strings: ShareStrings;
  readonly vendors: readonly ShareVendor[];
  readonly rows: readonly ShareRow[];
  readonly showDispatch: boolean;
  readonly axis: { readonly max: number; readonly ticks: readonly number[] };
}

const VENDORS = {
  anthropic: { name: "Anthropic", color: "#d95926" },
  google: { name: "Google", color: "#4a90f0" },
  openai: { name: "OpenAI", color: "#199e70" },
  deepseek: { name: "DeepSeek", color: "#c060c0" },
  xai: { name: "xAI", color: "#d4a017" },
  other: { name: "Other", color: "#8a93a3" },
} satisfies Record<string, ShareVendor>;
const VENDOR_ORDER = [
  VENDORS.anthropic,
  VENDORS.google,
  VENDORS.openai,
  VENDORS.deepseek,
  VENDORS.xai,
  VENDORS.other,
];

function vendorOf(model: string): ShareVendor {
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  if (id.startsWith("claude")) return VENDORS.anthropic;
  if (id.startsWith("gemini")) return VENDORS.google;
  if (id.startsWith("gpt") || id.startsWith("codex") || /^o\d/.test(id)) return VENDORS.openai;
  if (id.startsWith("deepseek")) return VENDORS.deepseek;
  if (id.startsWith("grok")) return VENDORS.xai;
  return VENDORS.other;
}

/** The client a request ran through, colored by that client's vendor; third-party clients are neutral. */
const CHANNELS: Readonly<Record<string, { label: string; color: string }>> = {
  claude: { label: "Claude Code", color: VENDORS.anthropic.color },
  antigravity: { label: "Antigravity", color: VENDORS.google.color },
  codex: { label: "Codex", color: VENDORS.openai.color },
  grok: { label: "Grok CLI", color: VENDORS.xai.color },
  opencode: { label: "OpenCode", color: VENDORS.other.color },
  cursor: { label: "Cursor", color: VENDORS.other.color },
  pi: { label: "Pi", color: VENDORS.other.color },
  muse: { label: "Muse Code", color: VENDORS.other.color },
};

// Ids that are gateway aliases rather than the model's own name.
const NAME_ALIASES: Readonly<Record<string, string>> = {
  "deepseek-flash": "DeepSeek V4.1 Flash",
};
const EFFORT_SUFFIX = /-(extra-low|xhigh|high|medium|low|minimal)$/;
const DATE_SUFFIX = /-\d{8}$/;

function titleToken(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "gpt") return "GPT";
  if (lower === "oss") return "OSS";
  if (lower === "deepseek") return "DeepSeek";
  if (/^v\d/.test(lower)) return `V${token.slice(1)}`;
  if (/^\d+[a-z]$/.test(lower)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** "claude-opus-5-5" becomes "Claude Opus 5.5"; an effort suffix is kept in parentheses. */
export function modelDisplayName(model: string): string {
  const id = model.slice(model.lastIndexOf("/") + 1);
  const alias = NAME_ALIASES[id];
  if (alias !== undefined) return alias;
  const effort = EFFORT_SUFFIX.exec(id)?.[1];
  const base = id
    .replace(EFFORT_SUFFIX, "")
    .replace(DATE_SUFFIX, "")
    .replace(/-build$/, "");
  const words: string[] = [];
  let digits: string[] = [];
  const flush = () => {
    if (digits.length > 0) words.push(digits.join("."));
    digits = [];
  };
  for (const token of base.split("-")) {
    if (/^\d+$/.test(token)) {
      digits.push(token);
      continue;
    }
    flush();
    words.push(titleToken(token));
  }
  flush();
  // GPT's version or family attaches to the name: "GPT-6.1 Sol", "GPT-OSS 120B".
  const name =
    words[0] === "GPT" && words[1] !== undefined && /^(\d|OSS$)/.test(words[1])
      ? [`GPT-${words[1]}`, ...words.slice(2)].join(" ")
      : words.join(" ");
  return effort === undefined ? name : `${name} (${effort})`;
}

export function defaultShareLang(locale: string): ShareLang {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function shareFilename(today: string, lang: ShareLang): string {
  return `model-speed-${today}-${lang}.png`;
}

const AXIS_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000];

export function shareAxis(maxRate: number): ShareData["axis"] {
  const step = AXIS_STEPS.find((candidate) => Math.ceil(maxRate / candidate) <= 5) ?? 2000;
  const max = Math.max(maxRate * 1.05, step);
  const ticks: number[] = [];
  for (let tick = 0; tick <= max; tick += step) ticks.push(tick);
  return { max, ticks };
}

function strings(
  lang: ShareLang,
  period: string,
  options: { thin: boolean; showDispatch: boolean; missingDispatch: boolean },
): ShareStrings {
  if (lang === "zh") {
    return {
      title: "我用过的模型 · 输出速率排行",
      badge: "T3 Code",
      subtitle: `从本机会话日志汇总 · ${period} · 单次输出 ≥1000 token 的请求取中位数`,
      speedHeader: "速率 tok/s",
      dispatchHeader: "派发成功",
      thinKey: options.thin ? "斜纹：速率样本 <20 次" : null,
      noDispatchKey:
        options.showDispatch && options.missingDispatch ? `${EM_DASH}：没有派发记录` : null,
      notes: [
        "速率 = 输出 token（含思考）÷ 单次请求耗时（含首字等待、网络与排队），是我这台机器上的实际体验，不是厂商标称的纯生成速度。",
        `${options.showDispatch ? "派发成功 = 我在 T3 Code 里派给该模型的任务中，经复核通过、未越界、返工不超过 1 轮的次数 / 派发次数（全部历史，不随时段变）。" : ""}名称下方标签为调用通道（客户端），颜色为其所属厂商，OpenCode 为第三方客户端。同一模型经不同通道调用时分开统计。`,
      ],
      brand: "由 T3 Code 生成",
    };
  }
  return {
    title: "Output Speed of the Models I Use",
    badge: "T3 Code",
    subtitle: `Compiled from my local session logs · ${period} · median of requests with ≥1,000 output tokens`,
    speedHeader: "tok/s",
    dispatchHeader: "Tasks passed",
    thinKey: options.thin ? "Hatched: <20 speed samples" : null,
    noDispatchKey:
      options.showDispatch && options.missingDispatch ? `${EM_DASH}: no delegated tasks` : null,
    notes: [
      "Speed = output tokens (incl. thinking) ÷ request wall time (incl. time to first token, network and queueing). Real-world speed on my machine, not vendor-reported decode speed.",
      `${options.showDispatch ? "Tasks passed = tasks I delegated to the model in T3 Code that passed review with no scope violation and at most one rework round, out of all tasks delegated (all time, not limited to the period). " : ""}The tag under each name is the client it ran through, colored by the client’s vendor (OpenCode is third-party). The same model used through different clients is counted separately.`,
    ],
    brand: "Generated with T3 Code",
  };
}

/** Rows with no long-output sample are left out: their speed rests on short requests only. */
export function buildShareData(
  ranking: readonly SpeedRanking[],
  period: { readonly sinceDay: string; readonly untilDay: string },
  lang: ShareLang,
): ShareData {
  const ranked = ranking.filter((row) => row.longRate !== null);
  const showDispatch = ranked.some((row) => row.dispatch !== null);
  const rows = ranked.map((row, index): ShareRow => {
    const vendor = vendorOf(row.model);
    const tier = row.tier === undefined ? "" : ` (${row.tier})`;
    return {
      rank: index + 1,
      name: `${modelDisplayName(row.model)}${tier}`,
      channel: CHANNELS[row.provider] ?? { label: row.provider, color: VENDORS.other.color },
      color: vendor.color,
      rate: row.longRate ?? 0,
      thin: row.lowSample,
      dispatch: row.dispatch === null ? null : `${row.dispatch.successes}/${row.dispatch.total}`,
    };
  });
  const present = new Set(ranked.map((row) => vendorOf(row.model).name));
  const joiner = lang === "zh" ? " 至 " : " to ";
  return {
    lang,
    strings: strings(lang, `${period.sinceDay}${joiner}${period.untilDay}`, {
      thin: rows.some((row) => row.thin),
      showDispatch,
      missingDispatch: rows.some((row) => row.dispatch === null),
    }),
    vendors: VENDOR_ORDER.filter((vendor) => present.has(vendor.name)),
    rows,
    showDispatch,
    axis: shareAxis(Math.max(0, ...rows.map((row) => row.rate))),
  };
}
