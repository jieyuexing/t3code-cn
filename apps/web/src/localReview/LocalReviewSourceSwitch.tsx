import { useNavigate } from "@tanstack/react-router";

import { Button } from "../components/ui/button";

export function LocalReviewSourceSwitch({ active }: { active: "pull-requests" | "local" }) {
  const navigate = useNavigate();
  const select = (source: "local" | undefined) =>
    void navigate({
      to: "/pull-requests",
      search: (previous) => {
        const { source: _source, ...rest } = previous;
        const kept = {
          ...rest,
          involvement: rest.involvement ?? ("all" as const),
          state: rest.state ?? ("open" as const),
        };
        return source === undefined ? kept : { ...kept, source };
      },
    });
  return (
    <div role="tablist" aria-label="来源" className="flex shrink-0 items-center gap-0.5">
      <Button
        role="tab"
        aria-selected={active === "pull-requests"}
        size="xs"
        variant={active === "pull-requests" ? "secondary" : "ghost-muted"}
        onClick={() => select(undefined)}
      >
        拉取请求
      </Button>
      <Button
        role="tab"
        aria-selected={active === "local"}
        size="xs"
        variant={active === "local" ? "secondary" : "ghost-muted"}
        onClick={() => select("local")}
      >
        本地
      </Button>
    </div>
  );
}
