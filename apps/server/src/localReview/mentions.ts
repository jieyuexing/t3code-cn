export type MentionForm = "bracket" | "commit" | "full" | "oneline";

export interface CommitMention {
  readonly token: string;
  readonly form: MentionForm;
}

export interface RangeMention {
  readonly from: string;
  readonly to: string;
}

export interface Mentions {
  readonly commits: ReadonlyArray<CommitMention>;
  readonly ranges: ReadonlyArray<RangeMention>;
}

const BRACKET = /^\[[^\]\n]+? (?:\(root-commit\) )?([0-9a-f]{7,40})\]/gm;
const COMMIT_LINE = /^commit ([0-9a-f]{7,40})\b/gm;
const FULL = /(?<![0-9a-zA-Z])([0-9a-f]{40})(?![0-9a-zA-Z])/g;
const RANGE = /(?<![0-9a-zA-Z])([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})(?![0-9a-zA-Z])/g;
const ONELINE = /^([0-9a-f]{7,12}) \S/gm;

const COMMIT_VERB = /\bgit\b[^\n]*?\b(commit|merge|cherry-pick|rebase|pull|am|revert)\b/;

const PATH_LITERAL = /(?:(?<=[\s"'=])|^)((?:\/|~\/)[^\s"';&|)]+)/g;

export function parseMentions(output: string): Mentions {
  const seen = new Map<string, MentionForm>();
  const add = (token: string, form: MentionForm) => {
    if (!seen.has(token)) seen.set(token, form);
  };
  for (const m of output.matchAll(BRACKET)) add(m[1]!, "bracket");
  for (const m of output.matchAll(COMMIT_LINE)) add(m[1]!, "commit");
  for (const m of output.matchAll(FULL)) add(m[1]!, "full");
  for (const m of output.matchAll(ONELINE)) {
    if (/[a-f]/.test(m[1]!)) add(m[1]!, "oneline");
  }
  const ranges: RangeMention[] = [];
  for (const m of output.matchAll(RANGE)) ranges.push({ from: m[1]!, to: m[2]! });
  return {
    commits: [...seen].map(([token, form]) => ({ token, form })),
    ranges,
  };
}

export function literalPaths(input: string): ReadonlyArray<string> {
  return [...new Set([...input.matchAll(PATH_LITERAL)].map((m) => m[1]!))];
}

export function isCommitCommand(input: string): boolean {
  return COMMIT_VERB.test(input);
}

const CHANGE_DIRECTORY =
  /(?:^|[;&|\n(]\s*)cd\s+(?:--\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)]+))/g;

export function lastChangedDirectory(input: string): string | null {
  let last: string | null = null;
  for (const m of input.matchAll(CHANGE_DIRECTORY)) {
    const target = m[1] ?? m[2] ?? m[3] ?? "";
    if (target.startsWith("/") || target.startsWith("~/")) last = target;
  }
  return last;
}
