import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useRightPanelStore } from "../rightPanelStore";
import { useFocusSurfaceStore } from "./focusSurface";
import { usePluginFocus } from "./usePluginFocus";

const fixture = vi.hoisted(() => ({
  reads: {} as Record<
    string,
    { isNotFile: boolean; isPending: boolean; data: object | null; readError: object | null }
  >,
}));

vi.mock("../components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_env: string, _cwd: string, path: string | null) =>
    fixture.reads[path ?? ""] ?? { isNotFile: false, isPending: false, data: {}, readError: null },
}));

const environmentId = EnvironmentId.make("environment-a");
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-A"));

function Probe(props: { cwd: string | null }) {
  const focus = usePluginFocus(environmentId, ref, props.cwd);
  return (
    <output data-testid="focus">
      {focus === undefined ? "unresolved" : JSON.stringify(focus)}
    </output>
  );
}

function setup() {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useFocusSurfaceStore.setState({ byThreadKey: {} });
  fixture.reads = {};
}

it("reports a file tab by its file, a folder tab by the folder, and the explorer by the workspace root", async () => {
  setup();
  fixture.reads["projects/b"] = { isNotFile: true, isPending: false, data: null, readError: {} };
  await using screen = await render(<Probe cwd="/w" />, { router: false });
  const focus = screen.getByTestId("focus");
  await expect.element(focus).toHaveTextContent("null");

  useRightPanelStore.getState().openFile(ref, "projects/a/x.ts");
  await expect.element(focus).toHaveTextContent('{"path":"/w/projects/a/x.ts","kind":"file"}');
  useRightPanelStore.getState().openFile(ref, "projects/b");
  await expect.element(focus).toHaveTextContent('{"path":"/w/projects/b","kind":"folder"}');
  useRightPanelStore.getState().open(ref, "files");
  await expect.element(focus).toHaveTextContent('{"path":"/w","kind":"folder"}');
});

it("tells nothing before the kind is read, and keeps the earlier answer while the next tab is read", async () => {
  setup();
  fixture.reads["projects/b"] = { isNotFile: false, isPending: true, data: null, readError: null };
  useRightPanelStore.getState().openFile(ref, "projects/b");
  await using screen = await render(<Probe cwd="/w" />, { router: false });
  const focus = screen.getByTestId("focus");
  await expect.element(focus).toHaveTextContent("unresolved");

  fixture.reads["projects/b"] = { isNotFile: true, isPending: false, data: null, readError: {} };
  await screen.rerender(<Probe cwd="/w" />);
  await expect.element(focus).toHaveTextContent('{"path":"/w/projects/b","kind":"folder"}');

  fixture.reads["projects/c"] = { isNotFile: false, isPending: true, data: null, readError: null };
  useRightPanelStore.getState().openFile(ref, "projects/c");
  await expect.element(focus).toHaveTextContent('{"path":"/w/projects/b","kind":"folder"}');
});
