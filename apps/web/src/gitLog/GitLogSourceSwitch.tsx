import { useNavigate } from "@tanstack/react-router";

import { Button } from "../components/ui/button";

export function GitLogSourceSwitch({ active }: { active: "git" | "pull-requests" }) {
  const navigate = useNavigate();
  const select = (source: "git" | undefined) =>
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
        aria-selected={active === "git"}
        size="xs"
        variant={active === "git" ? "secondary" : "ghost-muted"}
        onClick={() => select("git")}
      >
        Git 日志
      </Button>
      <Button
        role="tab"
        aria-selected={active === "pull-requests"}
        size="xs"
        variant={active === "pull-requests" ? "secondary" : "ghost-muted"}
        onClick={() => select(undefined)}
      >
        拉取请求
      </Button>
    </div>
  );
}
