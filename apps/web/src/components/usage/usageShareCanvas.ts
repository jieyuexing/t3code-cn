import { EM_DASH, type ShareData } from "./usageShareModel";

const WIDTH = 1200;
const SCALE = 2;
const PAD_X = 60;
const FONT =
  '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", sans-serif';
const ROW_HEIGHT = 58;
const RANK_RIGHT = PAD_X + 30;
const NAME_RIGHT = RANK_RIGHT + 16 + 290;
const TRACK_LEFT = NAME_RIGHT + 16;
const TRACK_WIDTH = 528;
const RATE_RIGHT = TRACK_LEFT + TRACK_WIDTH + 16 + 72;
const DISPATCH_RIGHT = RATE_RIGHT + 16 + 96;
const CONTENT_WIDTH = WIDTH - PAD_X * 2;

const WORD_PATTERN = /[　-鿿＀-￯]\s*|[^\s　-鿿＀-￯]+\s*/g;

/** Breaks text into lines that fit `maxWidth`: CJK text between any two characters, Latin between words. */
export function wrapText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const piece of text.match(WORD_PATTERN) ?? []) {
    if (line !== "" && measure((line + piece).trimEnd()) > maxWidth) {
      lines.push(line.trimEnd());
      line = piece.trimStart();
    } else {
      line += piece;
    }
  }
  if (line !== "") lines.push(line.trimEnd());
  return lines;
}

type Align = "left" | "right" | "center";

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  centerY: number,
  font: { size: number; weight?: number; color: string; spacing?: number },
  align: Align = "left",
): number {
  ctx.font = `${font.weight ?? 400} ${font.size}px ${FONT}`;
  ctx.fillStyle = font.color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.letterSpacing = `${font.spacing ?? 0}px`;
  ctx.fillText(value, x, centerY);
  return ctx.measureText(value).width;
}

function measureWidth(
  ctx: CanvasRenderingContext2D,
  value: string,
  size: number,
  weight = 400,
  spacing = 0,
): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.letterSpacing = `${spacing}px`;
  return ctx.measureText(value).width;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radii: number | [number, number, number, number],
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radii);
}

function withAlpha(color: string, alpha: number): string {
  const value = Number.parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** A 45-degree stripe fill, 6px on and 5px off, laid out as CSS repeating-linear-gradient does. */
function hatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
) {
  const length = (w + h) * Math.SQRT1_2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.SQRT1_2 * (length / 2);
  const gradient = ctx.createLinearGradient(cx - dx, cy + dx, cx + dx, cy - dx);
  for (let at = 0; at < length; at += 11) {
    const from = at / length;
    const to = Math.min(1, (at + 6) / length);
    gradient.addColorStop(from, color);
    gradient.addColorStop(to, color);
    if (to < 1) {
      gradient.addColorStop(to, "rgba(0,0,0,0)");
      gradient.addColorStop(Math.min(1, (at + 11) / length), "rgba(0,0,0,0)");
    }
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
}

/** Draws the share image; returns its height in CSS pixels, so a dry run on any context sizes the canvas. */
function draw(ctx: CanvasRenderingContext2D, data: ShareData, height: number): number {
  const { strings, rows, axis } = data;
  ctx.fillStyle = "#0d0f13";
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.save();
  // radial-gradient(1200px 500px at 15% -10%, #1a2233 0, transparent 60%)
  ctx.translate(WIDTH * 0.15, -50);
  ctx.scale(1, 500 / 1200);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1200);
  glow.addColorStop(0, "#1a2233");
  glow.addColorStop(0.6, "rgba(26, 34, 51, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(-WIDTH, -1200, WIDTH * 3, 2400 + height * 3);
  ctx.restore();

  let y = 52;
  const badgeWidth = measureWidth(ctx, strings.badge, 14, 400, 0.6) + 24 + 2;
  ctx.strokeStyle = "#2c3445";
  ctx.lineWidth = 1;
  roundRect(ctx, PAD_X + 0.5, y + 0.5, badgeWidth - 1, 26, 13);
  ctx.stroke();
  text(ctx, strings.badge, PAD_X + 13, y + 13.5, { size: 14, color: "#aab4c6", spacing: 0.6 });
  y += 27 + 16;

  text(ctx, strings.title, PAD_X, y + 24, {
    size: 40,
    weight: 700,
    color: "#e9ecf1",
    spacing: 0.3,
  });
  y += 48 + 10;

  const subtitle = wrapText(
    (value) => measureWidth(ctx, value, 18),
    strings.subtitle,
    CONTENT_WIDTH,
  );
  for (const line of subtitle) {
    text(ctx, line, PAD_X, y + 11, { size: 18, color: "#9aa3b2" });
    y += 22;
  }
  y += 22;

  let x = PAD_X;
  for (const vendor of data.vendors) {
    ctx.fillStyle = vendor.color;
    roundRect(ctx, x, y + 3.5, 12, 12, 3);
    ctx.fill();
    x += 12 + 7;
    x += text(ctx, vendor.name, x, y + 9.5, { size: 16, color: "#c7cdd8" }) + 22;
  }
  y += 19 + 26;

  for (const tick of axis.ticks) {
    text(
      ctx,
      String(tick),
      TRACK_LEFT + (tick / axis.max) * TRACK_WIDTH,
      y + 12,
      { size: 13, color: "#7d8697" },
      "center",
    );
  }
  text(ctx, strings.speedHeader, RATE_RIGHT, y + 13, { size: 13, color: "#7d8697" }, "right");
  if (data.showDispatch) {
    text(
      ctx,
      strings.dispatchHeader,
      DISPATCH_RIGHT,
      y + 13,
      { size: 13, color: "#7d8697" },
      "right",
    );
  }
  y += 26;

  const rowsTop = y;
  const rowsBottom = rowsTop + rows.length * ROW_HEIGHT;
  ctx.fillStyle = "#232834";
  for (const tick of axis.ticks) {
    if (tick > 0)
      ctx.fillRect(
        TRACK_LEFT + (tick / axis.max) * TRACK_WIDTH - 0.5,
        rowsTop,
        1,
        rowsBottom - rowsTop,
      );
  }
  for (const row of rows) {
    const top = y + 6;
    text(ctx, String(row.rank), RANK_RIGHT, y + 29, { size: 17, color: "#5f6779" }, "right");
    text(ctx, row.name, NAME_RIGHT, top + 12, { size: 20, color: "#dfe3ea" }, "right");
    const chipTextWidth = measureWidth(ctx, row.channel.label, 12.5, 600);
    const chipWidth = chipTextWidth + 12 + 2;
    const chipX = NAME_RIGHT - chipWidth;
    roundRect(ctx, chipX, top + 28, chipWidth, 18, 5);
    ctx.fillStyle = withAlpha(row.channel.color, 0.12);
    ctx.fill();
    ctx.strokeStyle = withAlpha(row.channel.color, 0.55);
    ctx.lineWidth = 1;
    roundRect(ctx, chipX + 0.5, top + 28.5, chipWidth - 1, 17, 4.5);
    ctx.stroke();
    text(ctx, row.channel.label, chipX + 7, top + 37.5, {
      size: 12.5,
      weight: 600,
      color: row.channel.color,
    });

    const barWidth = (row.rate / axis.max) * TRACK_WIDTH;
    const barRadii: [number, number, number, number] = [0, 6, 6, 0];
    ctx.save();
    roundRect(ctx, TRACK_LEFT, y + 17, barWidth, 24, barRadii);
    if (row.thin) {
      ctx.clip();
      hatch(ctx, TRACK_LEFT, y + 17, barWidth, 24, row.color);
      ctx.restore();
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 1.5;
      roundRect(ctx, TRACK_LEFT + 0.75, y + 17.75, barWidth - 1.5, 22.5, [0, 5.25, 5.25, 0]);
      ctx.stroke();
    } else {
      ctx.fillStyle = row.color;
      ctx.fill();
      ctx.restore();
    }

    text(
      ctx,
      row.rate.toFixed(1),
      RATE_RIGHT,
      y + 29,
      { size: 21, weight: 700, color: "#e9ecf1" },
      "right",
    );
    if (data.showDispatch) {
      text(
        ctx,
        row.dispatch ?? EM_DASH,
        DISPATCH_RIGHT,
        y + 29,
        { size: 17, color: "#aeb6c4" },
        "right",
      );
    }
    y += ROW_HEIGHT;
  }

  y += 26;
  ctx.fillStyle = "#232834";
  ctx.fillRect(PAD_X, y, CONTENT_WIDTH, 1);
  y += 1 + 18;
  const lineHeight = 26.25;
  const keys = [strings.thinKey, strings.noDispatchKey].filter((key) => key !== null);
  if (keys.length > 0) {
    let keyX = PAD_X;
    for (const key of keys) {
      keyX += text(ctx, key, keyX, y + lineHeight / 2, { size: 15, color: "#b5bcc8" }) + 22;
    }
    y += lineHeight + 6;
  }
  for (const note of strings.notes) {
    for (const line of wrapText((value) => measureWidth(ctx, value, 15), note, CONTENT_WIDTH)) {
      text(ctx, line, PAD_X, y + lineHeight / 2, { size: 15, color: "#8a93a3" });
      y += lineHeight;
    }
  }
  y += 12;
  text(ctx, strings.brand, PAD_X, y + lineHeight / 2, { size: 15, color: "#c5ccd8" });
  y += lineHeight;
  return y + 40;
}

/** Renders the ranking as a dark 1200px-wide PNG at twice the pixel density. */
export async function renderShareImage(data: ShareData): Promise<Blob> {
  const scratch = document.createElement("canvas").getContext("2d");
  if (scratch === null) throw new Error("Canvas is not available.");
  const height = Math.ceil(draw(scratch, data, 0));
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas is not available.");
  ctx.scale(SCALE, SCALE);
  draw(ctx, data, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob === null ? reject(new Error("The image could not be encoded.")) : resolve(blob),
      "image/png",
    );
  });
}
