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

export function splitTxtChapters(raw: string): TxtChapter[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  const boundaries: Array<{ line: number; title: string }> = [];
  let inFrontMatter = true; // treat text before the first heading as preamble

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const headMatch = line.match(CHAPTER_HEAD);
    if (headMatch && line.length < 120) {
      boundaries.push({ line: i, title: normalizeHead(headMatch[0]) });
      inFrontMatter = false;
      continue;
    }
    if (inFrontMatter) continue; // don't treat a stray number in the preamble as a chapter
    if (NUMERAL_LINE.test(line) && looksLikeChapterContext(lines, i)) {
      boundaries.push({ line: i, title: `Rozdział ${line.trim().replace(/[.\-–—]$/, '')}` });
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
    const from = boundaries[b]!.line + 1; // skip the heading line itself
    const to = b + 1 < boundaries.length ? boundaries[b + 1]!.line : lines.length;
    const body = lines.slice(from, to).join('\n').trim();
    if (body.length < 40) continue;
    chapters.push({ title: boundaries[b]!.title, text: body });
  }
  if (chapters.length === 0) return [{ title: 'Całość', text: text.trim() }];
  return chapters;
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
