import { useSearch } from "@tanstack/react-router";

import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";
import { usePrimaryEnvironmentId } from "../state/environments";
import { LocalReviewPage } from "./LocalReviewPage";

export function PullRequestsRoute() {
  const search = useSearch({ from: "/_chat/pull-requests" });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (search.source !== "local") return <PullRequestsPage />;
  return <LocalReviewPage environmentId={search.environmentId ?? primaryEnvironmentId} />;
}
