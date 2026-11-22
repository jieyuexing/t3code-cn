import { useGT } from "gt-react";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { setFloatBrowserOnClose, useFloatBrowserOnClose } from "./floatBrowserOnClose.cn";

export function FloatBrowserOnCloseSetting() {
  const gt = useGT();
  const enabled = useFloatBrowserOnClose();
  return (
    <SettingsRow
      devicePreference
      title={gt("Float browser on close")}
      description={gt("Keep a floating preview in the corner after closing the browser panel.")}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setFloatBrowserOnClose(Boolean(checked))}
          aria-label={gt("Float browser on close")}
        />
      }
    />
  );
}
