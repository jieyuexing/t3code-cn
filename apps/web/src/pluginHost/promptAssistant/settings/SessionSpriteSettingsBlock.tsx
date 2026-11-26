import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useGT } from "gt-react";
import { type ReactNode, useState } from "react";

import { SettingsRow, SettingsSection } from "../../../components/settings/settingsLayout";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { RefreshIcon } from "../../../components/ui/refresh-icon";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { formatDateTimeTimestamp } from "../../../timestampFormat";
import {
  formatKeywordsInput,
  MAX_SPRITE_BLOCKED_KEYWORDS,
  MAX_SPRITE_KEYWORD_CHARS,
  numberChoicesWith,
  parseKeywordsInput,
  type PromptAdvisorConfig,
  type PromptAdvisorPayload,
  type SessionSpriteConfig,
  type SessionSpriteLedgerEntry,
  withSprite,
} from "./promptAdvisorConfig.logic";
import { useSessionSpriteLedger } from "./useSessionSpriteLedger";

const SCAN_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
const IDLE_MINUTES_OPTIONS = [1, 3, 5, 10, 15, 30] as const;
const PER_TURN_OPTIONS = [1, 2] as const;
const HOURLY_LIMIT_OPTIONS = [1, 2, 3, 5, 8, 12] as const;
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour);
const MAX_VISIBLE_LEDGER_ENTRIES = 20;

const formatHour = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

const sameKeywords = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

function Disclosure(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
        {props.title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-2 pt-2">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function NumberSelect(props: {
  readonly label: string;
  readonly value: number;
  readonly options: ReadonlyArray<number>;
  readonly formatLabel: (value: number) => string;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onChange: (value: number) => void;
}) {
  const choices = numberChoicesWith(props.options, props.value);
  return (
    <Select
      value={String(props.value)}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const parsed = Number(next);
        if (Number.isInteger(parsed)) props.onChange(parsed);
      }}
      disabled={props.disabled}
    >
      <SelectTrigger
        size="sm"
        className={props.className ?? "min-w-0 w-32 shrink-0"}
        aria-label={props.label}
      >
        <SelectValue>{props.formatLabel(props.value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {choices.map((option) => (
          <SelectItem hideIndicator key={option} value={String(option)}>
            {props.formatLabel(option)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Commits parsed keywords on blur so typing never round-trips to the draft per keystroke. */
function KeywordDraftTextarea(props: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      aria-label={props.label}
      placeholder={props.placeholder}
      maxLength={MAX_SPRITE_BLOCKED_KEYWORDS * (MAX_SPRITE_KEYWORD_CHARS + 2)}
      disabled={props.disabled}
      rows={5}
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft ?? props.value;
        setDraft(null);
        if (next !== props.value) props.onCommit(next);
      }}
    />
  );
}

function LedgerEntryRow(props: { readonly entry: SessionSpriteLedgerEntry }) {
  const gt = useGT();
  const { entry } = props;
  const decisionLabel: Record<SessionSpriteLedgerEntry["decision"], string> = {
    would_advance: gt("Would advance"),
    blocked_thread: gt("Blocked (thread)"),
    blocked_items: gt("Blocked (items)"),
    error: gt("Error", { $context: "session sprite ledger decision" }),
  };
  const formattedTime = formatDateTimeTimestamp(entry.ts, "locale") || entry.ts;
  const summaryNote =
    entry.decision === "would_advance"
      ? gt("{count, plural, one {{count} item kept} other {{count} items kept}}", {
          count: entry.keptItems.length,
        })
      : (entry.blockReason ??
        gt("{count, plural, one {{count} item filtered} other {{count} items filtered}}", {
          count: entry.droppedItems.length,
        }));
  const hasDetails =
    entry.draftMessage !== null || entry.keptItems.length > 0 || entry.droppedItems.length > 0;

  return (
    <li className="rounded-md border border-border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">{formattedTime}</span>
          <span className="font-medium text-foreground">{entry.threadTitle || entry.threadId}</span>
          <Badge variant="outline" size="sm">
            {decisionLabel[entry.decision]}
          </Badge>
        </div>
        <span className="text-muted-foreground">{summaryNote}</span>
      </div>
      {hasDetails ? (
        <div className="mt-1.5">
          <Disclosure title={gt("Details", { $context: "session sprite ledger entry" })}>
            {entry.draftMessage === null ? null : (
              <div className="space-y-1">
                <p className="font-medium text-muted-foreground">{gt("Draft message")}</p>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap text-foreground">
                  {entry.draftMessage}
                </pre>
              </div>
            )}
            {entry.keptItems.length === 0 ? null : (
              <ul className="space-y-1">
                {entry.keptItems.map((item) => (
                  <li key={`${item.kind}:${item.label}:${item.fill}`} className="text-foreground">
                    <span className="font-medium">{item.label}</span>
                    <span className="block text-muted-foreground">{item.fill}</span>
                  </li>
                ))}
              </ul>
            )}
            {entry.droppedItems.length === 0 ? null : (
              <ul className="space-y-1">
                {entry.droppedItems.map((item) => (
                  <li
                    key={`${item.grade}:${item.kind}:${item.label}:${item.reason}`}
                    className="text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">
                      {gt("[{grade}] {label}", { grade: item.grade, label: item.label })}
                    </span>
                    {": "}
                    <span>{item.reason}</span>
                    {item.fill === "" ? null : <span className="block">{item.fill}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Third block on the prompt advisor settings page: shadow-mode session sprite configuration
 * and read-only observation ledger, kept self-contained for easy future extraction.
 */
export function SessionSpriteSettingsBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: PromptAdvisorPayload;
  readonly disabled: boolean;
  readonly onEdit: (config: PromptAdvisorConfig) => void;
}) {
  const gt = useGT();
  const { config, defaults } = props.payload;
  const sprite = config.sprite;
  const editSprite = (patch: Partial<SessionSpriteConfig>) =>
    props.onEdit(withSprite(config, patch));

  const ledgerState = useSessionSpriteLedger(props.environmentId);
  const { ledger, lastScanResult } = ledgerState;
  const visibleEntries = (ledger?.entries ?? []).slice(0, MAX_VISIBLE_LEDGER_ENTRIES);
  const blockedTotal =
    ledger === null ? 0 : ledger.summary.blockedThread + ledger.summary.blockedItems;
  const lastScanText =
    ledger?.summary.lastScanAt !== undefined && ledger.summary.lastScanAt !== null
      ? formatDateTimeTimestamp(ledger.summary.lastScanAt, "locale") || ledger.summary.lastScanAt
      : null;
  const keywordsAreDefault = sameKeywords(
    sprite.blockedTitleKeywords,
    defaults.sprite.blockedTitleKeywords,
  );

  return (
    <SettingsSection title={gt("Session sprite (shadow observation)")}>
      <SettingsRow
        title={gt("Live status")}
        status={
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{gt("Shadow · read-only")}</Badge>
              {ledger === null ? (
                ledgerState.loading ? (
                  <span>{gt("Loading ledger…")}</span>
                ) : null
              ) : (
                <span>
                  {gt(
                    "Evaluated {total} · Would advance {would} · Blocked {blocked} · Errors {errors}",
                    {
                      total: ledger.summary.totalEvaluated,
                      would: ledger.summary.wouldAdvance,
                      blocked: blockedTotal,
                      errors: ledger.summary.errors,
                    },
                  )}
                </span>
              )}
              {lastScanText === null ? null : (
                <span>{gt("Last scan {time}", { time: lastScanText })}</span>
              )}
            </div>
          </div>
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled || ledgerState.scanning}
              onClick={() => void ledgerState.scanNow()}
            >
              {ledgerState.scanning ? gt("Scanning…") : gt("Scan now")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              aria-label={gt("Refresh ledger")}
              disabled={ledgerState.loading || ledgerState.scanning}
              onClick={() => ledgerState.refresh()}
            >
              <RefreshIcon />
            </Button>
          </div>
        }
      >
        {lastScanResult !== null || ledgerState.error !== null ? (
          <div className="space-y-1 pb-2 text-xs">
            {lastScanResult === null ? null : (
              <p className="text-muted-foreground" data-testid="session-sprite-scan-result">
                {gt(
                  "Last scan: evaluated {scanned}, would advance {would}, blocked {blocked}, errors {errors}.",
                  {
                    scanned: lastScanResult.scanned,
                    would: lastScanResult.wouldAdvance,
                    blocked: lastScanResult.blocked,
                    errors: lastScanResult.errors,
                  },
                )}
              </p>
            )}
            {ledgerState.error === null ? null : (
              <p role="alert" className="text-destructive">
                {ledgerState.error}
              </p>
            )}
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title={gt("Enable shadow observation")}
        description={gt(
          "Periodically evaluates idle threads and records candidate drafts to the ledger without sending any messages.",
        )}
        control={
          <Switch
            checked={sprite.enabled}
            disabled={props.disabled}
            aria-label={gt("Enable shadow observation")}
            onCheckedChange={(enabled) => editSprite({ enabled })}
          />
        }
      />
      <SettingsRow
        title={gt("Scan cadence and idle wait")}
        description={gt(
          "How often background scans check snapshots and how long a thread must stay idle first.",
        )}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <NumberSelect
              label={gt("Scan interval")}
              value={sprite.scanIntervalMinutes}
              options={SCAN_INTERVAL_OPTIONS}
              formatLabel={(minutes) => gt("Every {minutes}m", { minutes })}
              disabled={props.disabled}
              onChange={(scanIntervalMinutes) => editSprite({ scanIntervalMinutes })}
            />
            <NumberSelect
              label={gt("Idle wait")}
              value={sprite.idleMinutes}
              options={IDLE_MINUTES_OPTIONS}
              formatLabel={(minutes) => gt("Idle {minutes}m", { minutes })}
              disabled={props.disabled}
              onChange={(idleMinutes) => editSprite({ idleMinutes })}
            />
          </div>
        }
      />
      <SettingsRow
        title={gt("Rate limits")}
        description={gt("Caps evaluations per thread turn and across all threads each hour.")}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <NumberSelect
              label={gt("Per-turn limit")}
              value={sprite.maxPerThreadPerHumanTurn}
              options={PER_TURN_OPTIONS}
              formatLabel={(count) => gt("{count} / turn", { count })}
              disabled={props.disabled}
              onChange={(maxPerThreadPerHumanTurn) => editSprite({ maxPerThreadPerHumanTurn })}
            />
            <NumberSelect
              label={gt("Hourly limit")}
              value={sprite.maxGlobalPerHour}
              options={HOURLY_LIMIT_OPTIONS}
              formatLabel={(count) => gt("{count} / hour", { count })}
              disabled={props.disabled}
              onChange={(maxGlobalPerHour) => editSprite({ maxGlobalPerHour })}
            />
          </div>
        }
      />
      <SettingsRow
        title={gt("Quiet hours")}
        description={gt("Skips automatic scans during the selected local hours.")}
        control={
          <Switch
            checked={sprite.quietHoursEnabled}
            disabled={props.disabled}
            aria-label={gt("Quiet hours")}
            onCheckedChange={(quietHoursEnabled) => editSprite({ quietHoursEnabled })}
          />
        }
      />
      {sprite.quietHoursEnabled ? (
        <SettingsRow
          title={gt("Quiet window")}
          description={gt("Local clock start and end hours for automatic scan suppression.")}
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <NumberSelect
                label={gt("Quiet start")}
                value={sprite.quietStartHour}
                options={HOUR_OPTIONS}
                formatLabel={formatHour}
                disabled={props.disabled}
                className="min-w-0 w-24 shrink-0"
                onChange={(quietStartHour) => editSprite({ quietStartHour })}
              />
              <NumberSelect
                label={gt("Quiet end")}
                value={sprite.quietEndHour}
                options={HOUR_OPTIONS}
                formatLabel={formatHour}
                disabled={props.disabled}
                className="min-w-0 w-24 shrink-0"
                onChange={(quietEndHour) => editSprite({ quietEndHour })}
              />
            </div>
          }
        />
      ) : null}
      <SettingsRow
        title={gt("Blocked thread title keywords")}
        description={gt(
          "One keyword per line or comma-separated. Threads whose title matches are skipped without calling the model.",
        )}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled || keywordsAreDefault}
            aria-label={gt("Restore default blocked keywords")}
            onClick={() =>
              editSprite({ blockedTitleKeywords: [...defaults.sprite.blockedTitleKeywords] })
            }
          >
            {gt("Restore default")}
          </Button>
        }
      >
        <div className="pb-2">
          <Disclosure
            title={gt("Edit blocked keywords ({count})", {
              count: sprite.blockedTitleKeywords.length,
            })}
          >
            <KeywordDraftTextarea
              label={gt("Blocked title keywords")}
              placeholder={gt("One keyword per line")}
              value={formatKeywordsInput(sprite.blockedTitleKeywords)}
              disabled={props.disabled}
              onCommit={(text) =>
                editSprite({ blockedTitleKeywords: [...parseKeywordsInput(text)] })
              }
            />
          </Disclosure>
        </div>
      </SettingsRow>
      <SettingsRow
        title={gt("Recent observations")}
        description={
          ledger !== null && ledger.ledgerPath !== "" ? (
            <code className="font-mono text-xs">{ledger.ledgerPath}</code>
          ) : undefined
        }
      >
        <div className="pb-2" data-testid="session-sprite-ledger">
          {visibleEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {ledgerState.loading
                ? gt("Loading observations…")
                : gt("No observations recorded yet.")}
            </p>
          ) : (
            <Disclosure
              title={gt("View recent observations ({count})", { count: visibleEntries.length })}
            >
              <ul className="space-y-2">
                {visibleEntries.map((entry) => (
                  <LedgerEntryRow key={`${entry.runId}:${entry.ts}`} entry={entry} />
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
