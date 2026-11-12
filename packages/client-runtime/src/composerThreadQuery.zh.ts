/** Fork-only: the composer's thread mentions also match titles that skip a word. */

const LATIN = /\p{Script=Latin}/u;
const DIGIT = /\p{Nd}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

type CharacterClass = "cjk" | "latin" | "digit";

// Chinese and Japanese text has no spaces, so a boundary next to it is a word break. Same
// ranges as the palette's word starts, plus the supplementary ideographs.
function isCjk(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

/** The kind of character a space would separate; null for punctuation, symbols, and spaces. */
function characterClass(character: string): CharacterClass | null {
  if (isCjk(character)) return "cjk";
  if (LATIN.test(character)) return "latin";
  if (DIGIT.test(character)) return "digit";
  return null;
}

/**
 * `query` with spaces where Chinese/Japanese, Latin letters, and digits meet, and
 * Chinese/Japanese runs cut into two-character words (an odd run leaves its last character
 * alone), so "@水墨grok" can find "水墨同题 · Grok 4.7". Null when the query already reads
 * as those words, which keeps every other query on its existing path.
 */
export function expandComposerThreadQuery(query: string): string | null {
  const pieces: string[] = [];
  let piece = "";
  let previous: CharacterClass | null = null;
  let cjkRun = 0;
  const closePiece = () => {
    // Trailing punctuation ("同题·") would have to match as typed, and a piece of punctuation
    // alone would have to match on its own, so both are dropped.
    const word = piece.replace(/[^\p{L}\p{N}]+$/u, "");
    if (word.length > 0 && LETTER_OR_DIGIT.test(word)) pieces.push(word);
    piece = "";
    cjkRun = 0;
  };
  for (const character of query) {
    const kind = characterClass(character);
    if (/\s/u.test(character)) {
      closePiece();
      previous = null;
      continue;
    }
    if (kind !== null && previous !== null && kind !== previous) closePiece();
    if (kind === "cjk") {
      if (cjkRun === 2) closePiece();
      cjkRun += 1;
    } else if (kind === null) {
      cjkRun = 0;
    }
    piece += character;
    previous = kind;
  }
  closePiece();
  return pieces.length > 1 && pieces.join(" ") !== query.trim().replace(/\s+/gu, " ")
    ? pieces.join(" ")
    : null;
}
