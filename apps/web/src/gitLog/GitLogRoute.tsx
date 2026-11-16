import { useSearch } from "@tanstack/react-router";

import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";
import { usePrimaryEnvironmentId } from "../state/environments";
import { GitLogPage } from "./GitLogPage";

export function PullRequestsRoute() {
  const search = useSearch({ from: "/_chat/pull-requests" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (search.source !== "git") return <PullRequestsPage />;
  return <GitLogPage environmentId={search.environmentId ?? primaryEnvironmentId} />;
}
