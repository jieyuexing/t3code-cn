import { createFileRoute } from "@tanstack/react-router";

import { BerthsPage } from "../berths/BerthsPage";

export const Route = createFileRoute("/_chat/berths")({
  component: BerthsPage,
});
