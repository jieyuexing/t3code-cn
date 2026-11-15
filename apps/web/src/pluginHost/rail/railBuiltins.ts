import type { RailBuiltinId } from "@t3tools/contracts";
import {
  FileDiff,
  Files,
  Globe2,
  MessageCircleQuestionMark,
  MessagesSquare,
  Smartphone,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const RAIL_BUILTIN_LABELS: Readonly<
  Record<
    RailBuiltinId,
    { readonly label: string; readonly icon: LucideIcon | ComponentType<{ className?: string }> }
  >
> = {
  browser: { label: "Browser", icon: Globe2 },
  terminal: { label: "Terminal", icon: TerminalSquare },
  files: { label: "Files", icon: Files },
  diff: { label: "Diff", icon: FileDiff },
  pullRequest: { label: "Pull request", icon: PullRequestGlyph.pullRequest },
  pullRequests: { label: "Linked pull requests", icon: PullRequestGlyph.link },
  device: { label: "Device", icon: Smartphone },
  sideChat: { label: "Side chat", icon: MessagesSquare },
  needsYou: { label: "Needs you", icon: MessageCircleQuestionMark },
};
