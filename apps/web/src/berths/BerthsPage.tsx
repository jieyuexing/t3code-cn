/* oxlint-disable t3code/no-untranslated-copy -- fork-only UI copy */
import { useAtomValue } from "@effect/atom-react";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useEnvironmentShellStatus } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { isThreadRouteSnapshotAuthoritative } from "../threadRoutes";
import { buildBerthView } from "./berths.logic";
import { BerthsBoard } from "./BerthsBoard";

export function BerthsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const [picked, setPicked] = useState<EnvironmentId | null>(null);
  const environmentId = picked ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const tasks = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const ready = isThreadRouteSnapshotAuthoritative(useEnvironmentShellStatus(environmentId));
  const navigate = useNavigate();

  const view =
    environmentId === null
      ? null
      : buildBerthView({
          shells,
          environmentId,
          // oxlint-disable-next-line react/purity -- the view is as of this render; an ended snooze shows on the next shell update
          now: new Date().toISOString(),
          scheduledThreadIds: new Set(
            (tasks.data?.tasks ?? []).flatMap((task) =>
              task.threadId === null ? [] : [task.threadId],
            ),
          ),
        });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="工作泊位">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">工作泊位（6 格）</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {environments.length > 1 && environmentId !== null ? (
            <Select
              value={environmentId}
              onValueChange={(next) => setPicked(next ?? environmentId)}
            >
              <SelectTrigger size="sm" aria-label="选择环境" className="w-48 min-w-0 shrink-0">
                <SelectValue>
                  {environments.find((entry) => entry.environmentId === environmentId)?.label ?? ""}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((entry) => (
                  <SelectItem key={entry.environmentId} value={entry.environmentId}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </WorkspacePageHeader>
        {environmentId === null || view === null ? (
          <p className="p-4 text-sm text-muted-foreground">没有可用的环境。</p>
        ) : (
          <BerthsBoard
            key={environmentId}
            environmentId={environmentId}
            view={view}
            ready={ready}
            onOpen={(threadId) =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: ThreadId.make(threadId) },
              })
            }
          />
        )}
      </div>
    </SidebarInset>
  );
}
