import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { useTheme } from "../hooks/useTheme";
import { usePluginViewContext } from "./viewContext";

function Probe() {
  const { setAppearanceMode } = useTheme();
  const context = usePluginViewContext("/work/a");
  return (
    <div>
      <button type="button" onClick={() => setAppearanceMode("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setAppearanceMode("light")}>
        light
      </button>
      <button type="button" onClick={() => setAppearanceMode("system")}>
        system
      </button>
      <output data-testid="context">{JSON.stringify(context)}</output>
    </div>
  );
}

const read = (screen: { container: HTMLElement }) =>
  JSON.parse(screen.container.querySelector("[data-testid=context]")!.textContent!) as {
    cwd: string;
    theme: { scheme: string; vars: Record<string, string> };
  };

it("reads the computed theme variables and follows the app to the other scheme", async () => {
  const root = document.documentElement;
  root.style.setProperty("--background", "rgb(250, 250, 250)");
  await using screen = await render(<Probe />, { router: false });
  try {
    await screen.getByText("light").click();
    await expect.poll(() => read(screen).theme.scheme).toBe("light");
    expect(read(screen)).toMatchObject({ cwd: "/work/a" });
    const light = read(screen).theme.vars["--background"];
    expect(light).toBeTruthy();

    root.style.setProperty("--background", "rgb(10, 10, 10)");
    await screen.getByText("dark").click();
    await expect.poll(() => read(screen).theme.scheme).toBe("dark");
    await expect.poll(() => read(screen).theme.vars["--background"]).not.toBe(light);
  } finally {
    // The test chose an appearance; put it and the variable back for whatever runs next.
    await screen.getByText("system").click();
    root.style.removeProperty("--background");
  }
});
