import { ImageIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { SpeedRanking } from "@t3tools/shared/usageSpeed";

import { getI18nSnapshot } from "../../i18n/runtime";
import { Button } from "../ui/button";
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
import { renderShareImage } from "./usageShareCanvas";
import { buildShareData, defaultShareLang, shareFilename, type ShareLang } from "./usageShareModel";

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

/** One click renders the current ranking as a PNG, to download or copy, in either language. */
export function UsageShareImage({
  ranking,
  period,
}: {
  readonly ranking: readonly SpeedRanking[];
  readonly period: { readonly sinceDay: string; readonly untilDay: string };
}) {
  const [image, setImage] = useState<RenderedImage | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const generate = async (lang: ShareLang) => {
    const request = (latest.current += 1);
    setBusy(true);
    let blob: Blob | null = null;
    try {
      blob = await renderShareImage(buildShareData(ranking, period, lang));
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
                className="max-h-[60vh] w-full rounded-md object-contain object-top"
              />
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
