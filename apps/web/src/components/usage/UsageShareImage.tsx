import { ImageIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { SpeedRanking } from "@t3tools/shared/usageSpeed";

import { getI18nSnapshot } from "../../i18n/runtime";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { readShareChoices, saveShareChoices } from "./usageShareChoices";
import { renderShareImage } from "./usageShareCanvas";
import {
  buildShareData,
  defaultShareLang,
  excludedShareKeys,
  shareFilename,
  shareOptionLabel,
  shareOptions,
  type ShareChoices,
  type ShareLang,
} from "./usageShareModel";

interface RenderedImage {
  readonly lang: ShareLang;
  readonly blob: Blob;
  readonly url: string;
}

const LANGUAGES = [
  { value: "zh", label: "中文" },
  { value: "en", label: "EN" },
] as const satisfies readonly { value: ShareLang; label: string }[];

function today(): string {
  return new Intl.DateTimeFormat("en-CA").format(Date.now());
}

/**
 * One click renders the current ranking as a PNG, to download or copy, in either language. Rows
 * with few long samples start unticked; ticks are remembered per row.
 */
export function UsageShareImage({
  ranking,
  period,
}: {
  readonly ranking: readonly SpeedRanking[];
  readonly period: { readonly sinceDay: string; readonly untilDay: string };
}) {
  const [image, setImage] = useState<RenderedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ShareChoices>(readShareChoices);
  const latest = useRef(0);
  const options = shareOptions(ranking, choices);
  const ticked = options.filter((option) => option.checked).length;

  const generate = async (lang: ShareLang, current: ShareChoices = choices) => {
    const request = (latest.current += 1);
    setBusy(true);
    let blob: Blob | null = null;
    try {
      const excluded = excludedShareKeys(shareOptions(ranking, current));
      blob = await renderShareImage(buildShareData(ranking, period, lang, excluded));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not generate the image",
        description: error instanceof Error ? error.message : undefined,
      });
    }
    // A newer request, or closing the dialog, owns the state now.
    if (request !== latest.current) return;
    setBusy(false);
    if (blob === null) return;
    const rendered = blob;
    setImage((previous) => {
      if (previous !== null) URL.revokeObjectURL(previous.url);
      return { lang, blob: rendered, url: URL.createObjectURL(rendered) };
    });
  };

  const close = () => {
    latest.current += 1;
    setBusy(false);
    setImage((previous) => {
      if (previous !== null) URL.revokeObjectURL(previous.url);
      return null;
    });
  };

  const toggle = (key: string, checked: boolean, lang: ShareLang) => {
    const next = { ...choices, [key]: checked };
    setChoices(next);
    saveShareChoices(next);
    void generate(lang, next);
  };

  const download = (current: RenderedImage) => {
    const anchor = document.createElement("a");
    anchor.href = current.url;
    anchor.download = shareFilename(today(), current.lang);
    anchor.click();
  };

  const copy = async (current: RenderedImage) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": current.blob })]);
      toastManager.add({ type: "success", title: "Image copied" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy the image",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || ranking.every((row) => row.longRate === null)}
        onClick={() => void generate(defaultShareLang(getI18nSnapshot().locale))}
      >
        <ImageIcon aria-hidden />
        Share image
      </Button>
      {image === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <DialogPopup className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Share image</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <img
                src={image.url}
                alt="Output speed ranking"
                className="max-h-[45vh] w-full rounded-md object-contain object-top"
              />
              <fieldset className="mt-4 flex flex-col gap-1.5">
                <legend className="mb-1 text-xs text-muted-foreground">
                  Rows in the image, with long-output samples
                </legend>
                <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {options.map((option) => (
                    <label
                      key={option.key}
                      className="flex min-w-0 items-center gap-2 text-sm text-foreground"
                    >
                      <Checkbox
                        checked={option.checked}
                        disabled={option.checked && ticked === 1}
                        onCheckedChange={(checked) => toggle(option.key, checked, image.lang)}
                      />
                      <span className="min-w-0 truncate">{shareOptionLabel(option.row)}</span>
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {option.row.longRequests}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </DialogPanel>
            <DialogFooter variant="bare" className="items-center sm:justify-between">
              <ToggleGroup
                aria-label="Image language"
                variant="segmented"
                value={[image.lang]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "zh" || value === "en") void generate(value);
                }}
              >
                {LANGUAGES.map((language) => (
                  <Toggle key={language.value} value={language.value}>
                    {language.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => void copy(image)}>
                  Copy
                </Button>
                <Button onClick={() => download(image)}>Download PNG</Button>
              </div>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}
