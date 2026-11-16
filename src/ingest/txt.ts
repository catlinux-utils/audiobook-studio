/**
 * Plain-text ingest: detect chapter boundaries with multilingual heuristics.
 * Falls back to a single chapter if nothing recognizable exists.
 */

export interface TxtChapter {
  title: string;
  text: string;
}

const CHAPTER_HEAD = /^\s*(?:rozdział|rozdz|część|częsc|dział|tom|księga|chapter|part|book|kapitel)\s+([\wIVXLC]+[.\-:]?)\s*(.*)$/i;

/** Match a bare roman numeral or number on its own line ("III", "12."). */
const NUMERAL_LINE = /^\s*((?:[IVXLCivxlc]{1,7})|\d{1,4})[.\-–—]?\s*$/;

/** Match "XXIV. NA JEDEN DZIEŃ" / "1. The Journey" — numeral plus inline title. */
const NUMERAL_HEAD = /^\s*((?:[IVXLCivxlc]{1,7})|\d{1,4})[.\-–—]?\s+(.{2,})$/;

interface Boundary {
  line: number;
  title: string;
  /** extra lines (the title line) consumed after the heading line itself */
  consumed: number;
}

export function splitTxtChapters(raw: string): TxtChapter[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const boundaries: Boundary[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const headMatch = line.match(CHAPTER_HEAD);
    if (headMatch && line.length < 120) {
      boundaries.push({ line: i, title: normalizeHead(headMatch[0]), consumed: 0 });
      continue;
    }
    const numeralHead = line.match(NUMERAL_HEAD);
    if (
      numeralHead &&
      line.length < 120 &&
      isTitleText(numeralHead[2]!) &&
      (isCapsTitle(numeralHead[2]!) || looksLikeChapterContext(lines, i))
    ) {
      boundaries.push({ line: i, title: normalizeHead(line), consumed: 0 });
      continue;
    }
    if (NUMERAL_LINE.test(line) && looksLikeChapterContext(lines, i)) {
      const numeral = line.trim().replace(/[.\-–—]$/, '');
      const { title, consumed } = peekTitleLine(lines, i, numeral);
      boundaries.push({ line: i, title, consumed });
    }
  }

  if (boundaries.length === 0) {
    return [{ title: 'Całość', text: text.trim() }];
  }

  const chapters: TxtChapter[] = [];
  // preamble (title page, dedication, ...) becomes its own chapter if non-trivial
  if (boundaries[0]!.line > 4) {
    const preamble = lines.slice(0, boundaries[0]!.line).join('\n').trim();
    if (preamble.split(/\s+/).length > 30) {
      chapters.push({ title: 'Wstęp', text: preamble });
    }
  }
  for (let b = 0; b < boundaries.length; b++) {
    const from = boundaries[b]!.line + 1 + boundaries[b]!.consumed;
    const to = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;
    const body = lines.slice(from, to).join('\n').trim();
    if (body.length < 40) continue;
    chapters.push({ title: boundaries[b]!.title, text: body });
  }
  if (chapters.length === 0) return [{ title: 'Całość', text: text.trim() }];
  return chapters;
}

/**
 * A bare numeral may be followed by the chapter title on a nearby line
 * ("XXIV" + "NA JEDEN DZIEŃ"); merge it into the title and skip it in the body.
 */
function peekTitleLine(lines: string[], i: number, numeral: string): { title: string; consumed: number } {
  const next = findLine(lines, i, +1);
  if (next !== null && next - i <= 4) {
    const t = lines[next]!.trim();
    if (isTitleText(t) && (isCapsTitle(t) || t.length < 100)) {
      return { title: `Rozdział ${numeral}. ${t}`, consumed: next - i };
    }
  }
  return { title: `Rozdział ${numeral}`, consumed: 0 };
}

/** Reject sentence-like text; titles don't end in sentence punctuation. */
function isTitleText(s: string): boolean {
  return s.length > 1 && s.length <= 100 && !/[.!?:;,]$/.test(s);
}

/** True when a string is predominantly uppercase letters (heading style). */
function isCapsTitle(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length >= 2 / 3;
}

function normalizeHead(head: string): string {
  const compact = head.replace(/\s+/g, ' ').trim();
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

/** A bare numeral counts as a chapter heading only in a heading-looking spot. */
function looksLikeChapterContext(lines: string[], i: number): boolean {
  const prevNonEmpty = findLine(lines, i, -1);
  const nextNonEmpty = findLine(lines, i, +1);
  if (!nextNonEmpty) return false;
  // heading line is surrounded by blank lines (classic ebook formatting)
  const blankBefore = prevNonEmpty === null || i - prevNonEmpty > 1;
  const blankAfter = nextNonEmpty - i > 1;
  return blankBefore && blankAfter;
}

function findLine(lines: string[], from: number, dir: -1 | 1): number | null {
  for (let i = from + dir; i >= 0 && i < lines.length; i += dir) {
    if (lines[i]!.trim()) return i;
  }
  return null;
}
