import { useId, useState } from "react";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { randomUUID } from "~/lib/utils";

import { parseWebAppUrl, type WebAppItem } from "./rail.logic";

/** The form that adds a web app to the rail or edits one; it is mounted only while it is open. */
export function RailWebAppDialog(props: {
  readonly app: WebAppItem | null;
  readonly onClose: () => void;
  readonly onSubmit: (app: WebAppItem) => void;
}) {
  const { app } = props;
  const formId = useId();
  const defaults = useBrowserDefaults();
  const [title, setTitle] = useState(app?.title ?? "");
  const [url, setUrl] = useState(app?.url ?? "");
  const [profileId, setProfileId] = useState(app?.profileId ?? defaults.profileId);
  const [invalidUrl, setInvalidUrl] = useState(false);

  const submit = () => {
    const href = parseWebAppUrl(url);
    const name = title.trim();
    if (href === null || name === "") {
      setInvalidUrl(href === null);
      return;
    }
    props.onSubmit({
      _tag: "web",
      id: app?.id ?? randomUUID(),
      title: name,
      url: href,
      profileId,
      ...(app?.pinned === undefined ? {} : { pinned: app.pinned }),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{app === null ? "Add web app" : "Edit web app"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-title`}>Title</Label>
              <Input
                id={`${formId}-title`}
                value={title}
                maxLength={60}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-url`}>Address</Label>
              <Input
                id={`${formId}-url`}
                placeholder="https://example.com"
                value={url}
                aria-invalid={invalidUrl || undefined}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setInvalidUrl(false);
                }}
              />
              {invalidUrl ? (
                <p className="text-destructive-foreground text-xs">
                  Enter an address that starts with http:// or https://.
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label>Browser profile</Label>
              <Select value={profileId} onValueChange={(value) => value && setProfileId(value)}>
                <SelectTrigger aria-label="Browser profile">
                  <SelectValue>
                    {(value: string | null) =>
                      defaults.profiles.find((profile) => profile.id === value)?.name ?? value
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {defaults.profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={title.trim() === "" || url.trim() === ""}>
            {app === null ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
