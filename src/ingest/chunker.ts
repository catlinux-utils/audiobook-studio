/**
 * Sentence-aware text chunker for TTS synthesis.
 *
 * OmniVoice (and TTS models generally) degrade on long inputs, so chapter text
 * is split into chunks at sentence boundaries. Every chunk keeps its character
 * offsets into the chapter's normalized text so the UI can show exactly where
 * the cuts are, and so "regenerate this chunk" maps back to source text.
 *
 * Design goals:
 * - never cut mid-sentence unless a single sentence exceeds the budget,
 *   then cut at the best inner punctuation (comma/semicolon/dash) and flag
 *   the chunk as a "soft cut" in the UI;
 * - handle Polish + English abbreviations ("prof.", "itd.", "Dr", "e.g."),
 *   initials ("J. K. Rowling"), decimals ("3.14"), and dialogue dashes
 *   ("— Nie wierzę — powiedziała.");
 * - be deterministic and pure (no deps) so it is fully unit-testable.
 */

export interface TextChunk {
  text: string;
  charStart: number;
  charEnd: number;
  /** true if this chunk ends mid-sentence (inner-punctuation or hard split). */
  softCut: boolean;
}

/** Polish and English abbreviations that must not end a sentence. */
const ABBREVIATIONS = new Set([
  // Polish
  'prof', 'dr', 'hab', 'mgr', 'inż', 'inżyn', 'doc', 'ul', 'al', 'os', 'pl', // pl. square also
  'tzw', 'tj', 'tzn', 'itp', 'itd', 'its', 'ok', 'm.in', 'jw', 'jbb', 'nr', 'str', 'wew',
  'zob', 'por', 'np', 'ang', 'niem', 'fr', 'łac', 'gł', 'dz', 'czerw', 'kwiecień',
  't', 's', 'r', 'w', 'n', 'z', 'o', 'św', 'śp', 'jm', 'gen', 'płk', 'ppłk', 'por', 'kpt',
  'ods', 'tłum', 'red', 'wyd', 'roczn', 'pol', 'muz', 'zobacz',
  // English
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'eg', 'ie',
  'approx', 'apt', 'dept', 'est', 'fig', 'no', 'vol', 'pp', 'ed', 'al', 'ca', 'cf',
]);

/** Normalize paragraph whitespace while preserving paragraph structure. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/) // paragraphs
    .map((p) => p.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n'))
    .filter((p) => p.length > 0)
    .join('\n\n');
}

function isAbbreviation(prefix: string): boolean {
  const lower = prefix.toLowerCase().replace(/[»"']$/, '');
  if (ABBREVIATIONS.has(lower)) return true;
  // single letter initial: "J. K. Rowling", "J.K.", but not "5." or words
  return /^[a-ząćęłńóśźż]$/i.test(lower);
}

/**
 * Split into sentences with char offsets. A "sentence" here is a span ending
 * at terminal punctuation that passes the abbreviation/initial/decimal guards.
 */
export function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  const terminal = /[.!?…]/;

  const pushSentence = (endExclusive: number) => {
    // skip leading whitespace so sentence text starts at its first glyph
    let begin = start;
    while (begin < endExclusive && /\s/.test(text[begin]!)) begin++;
    if (begin >= endExclusive) return;
    out.push({ text: text.slice(begin, endExclusive), start: begin, end: endExclusive });
  };

  for (let i = 0; i < text.length; i++) {
    // a sentence never crosses a paragraph boundary — verse/heading lines
    // without terminal punctuation must not swallow the next paragraph
    if (text[i] === '\n' && text[i + 1] === '\n') {
      pushSentence(i);
      start = i;
      i++;
      continue;
    }
    if (!terminal.test(text[i]!)) continue;

    // collect closing quotes/brackets right after the punctuation
    let end = i + 1;
    while (end < text.length && /["'”’»)\]]/.test(text[end]!)) end++;

    const next = text.slice(end).match(/^\s+(\S)/);
    if (!next) continue; // end of text — handled after the loop

    const afterChar = next[1]!;
    const before = text.slice(Math.max(0, i - 12), i);
    const wordMatch = before.match(/([^\s]+)$/);
    const word = wordMatch?.[1] ?? '';

    if (isAbbreviation(word)) continue;
    // next sentence usually starts uppercase; lowercase continuation means
    // this dot was likely an abbreviation we did not catch
    if (/[a-ząćęłńóśźż]/.test(afterChar) && !/[—–]/.test(afterChar)) continue;

    pushSentence(end);
    start = end;
  }
  pushSentence(text.length);
  return out;
}

/** Split one over-long sentence at the best inner punctuation, word-safe. */
function splitSentenceInner(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const hardMax = Math.max(maxChars * 2, 120);

  // candidate split points: after , ; : — – and closing clauses
  const candidates: number[] = [];
  const punct = /[,;:—–]/g;
  let m: RegExpExecArray | null;
  while ((m = punct.exec(sentence))) candidates.push(m.index + 1);
  // prefer the candidate closest to the middle of the target window
  candidates.sort((a, b) => Math.abs(a - maxChars) - Math.abs(b - maxChars));

  let cut = candidates[0];
  if (cut === undefined) {
    // no punctuation: split at a word boundary near maxChars
    const slice = sentence.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(' ');
    cut = lastSpace > maxChars / 2 ? lastSpace + 1 : maxChars;
  }

  const head = sentence.slice(0, cut).trimEnd();
  const tail = sentence.slice(cut).trimStart();
  if (!tail) return [sentence];
  const parts = [head, ...splitSentenceInner(tail, maxChars)];
  // final guard: extremely long unbroken tokens (URLs) get hard-split
  const result: string[] = [];
  for (const part of parts) {
    if (part.length <= hardMax) {
      result.push(part);
    } else {
      for (let i = 0; i < part.length; i += maxChars) {
        result.push(part.slice(i, i + maxChars));
      }
    }
  }
  return result;
}

/**
 * Heuristic: is this paragraph a heading/title rather than running text?
 * Headings merged into the following paragraph confuse diffusion TTS (it tends
 * to skip or merge repeated short lines), so the packer breaks there.
 * Conservative by design — false negatives just behave like before.
 */
export function isHeadingParagraph(paragraph: string): boolean {
  const t = paragraph.trim();
  if (!t || t.length > 40) return false;
  // a line that closes with punctuation is prose/verse continuation, not a title
  if (/[.!?…,:;]["'”’»)\]]*$/.test(t)) return false;
  // verse lines without final punctuation usually have several commas;
  // real titles have at most one ("Fraszki, Księgi pierwsze")
  const commas = (t.match(/,/g) ?? []).length;
  return commas <= 1;
}

/**
 * Pack sentences into chunks of at most `maxChars` characters.
 * Paragraph structure (\n\n) inside chunks is preserved verbatim, and the
 * packer never merges across a heading↔content paragraph boundary — headings
 * (and consecutive heading runs) become their own chunk.
 */
export function chunkText(text: string, maxChars = 280): TextChunk[] {
  let clean = normalizeText(text);
  if (!clean.trim()) return [];
  // EPUB headings arrive marked with '# ' (see parseEpub) — exact structure.
  // For unmarked text (TXT ingest) fall back to a heuristic, but only in the
  // title zone: beyond the first paragraphs, short unpunctuated lines are
  // usually verse, and treating them as headings fragments poetry.
  const rawParas = clean.split('\n\n');
  const marked = rawParas.map((p) => p.startsWith('# '));
  const paras = rawParas.map((p, i) => (marked[i] ? p.slice(2) : p));
  clean = paras.join('\n\n');
  const budget = Math.max(60, maxChars);
  const sentences = splitSentences(clean);
  const chunks: TextChunk[] = [];

  // paragraph ranges + heading flags, for boundary-aware packing
  const paragraphs: Array<{ start: number; end: number; heading: boolean }> = [];
  {
    let cursor = 0;
    paras.forEach((p, i) => {
      const start = cursor;
      cursor += p.length + 2;
      if (p.trim()) {
        paragraphs.push({
          start,
          end: start + p.length,
          heading: marked[i]! || (i <= 2 && isHeadingParagraph(p)),
        });
      }
    });
  }
  const paragraphAt = (offset: number): { heading: boolean } | null => {
    for (const p of paragraphs) if (offset >= p.start && offset < p.end) return { heading: p.heading };
    return null;
  };

  let current: Array<{ text: string; start: number; end: number }> = [];
  let currentLen = 0;
  let lastHeading: boolean | null = null; // heading-ness of the paragraph current ends in
  // every chunk is purely heading-run or purely content (transitions flush),
  // tracked for the tiny-tail merge below
  const chunkHeading: boolean[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    chunks.push({
      text: clean.slice(first.start, last.end),
      charStart: first.start,
      charEnd: last.end,
      softCut: false,
    });
    chunkHeading.push(lastHeading ?? false);
    current = [];
    currentLen = 0;
    lastHeading = null;
  };

  for (const sentence of sentences) {
    const para = paragraphAt(sentence.start);
    const heading = para?.heading ?? false;
    // heading-ness changed across this paragraph boundary → start a new chunk
    if (current.length > 0 && lastHeading !== null && heading !== lastHeading) flush();

    if (sentence.text.length > budget) {
      flush();
      const parts = splitSentenceInner(sentence.text, budget);
      let cursor = 0;
      for (const part of parts) {
        const rel = sentence.text.indexOf(part, cursor);
        const start = rel >= 0 ? sentence.start + rel : sentence.start + cursor;
        const end = start + part.length;
        cursor = rel >= 0 ? rel + part.length : cursor + part.length;
        chunks.push({ text: part, charStart: start, charEnd: end, softCut: true });
        chunkHeading.push(heading);
      }
      continue;
    }
    if (currentLen + (current.length > 0 ? 2 : 0) + sentence.text.length > budget && current.length > 0) {
      flush();
    }
    // account for the '\n\n' separator the packed text will actually contain
    currentLen += sentence.text.length + (current.length > 0 ? 2 : 0);
    current.push(sentence);
    lastHeading = heading;
  }
  flush();

  // absorb a tiny trailing content chunk into the previous content chunk —
  // sub-60-char chunks waste a synthesis request and risk degenerate output
  for (let i = 1; i < chunks.length; i++) {
    const cur = chunks[i]!;
    const prev = chunks[i - 1]!;
    if (
      !chunkHeading[i] &&
      !chunkHeading[i - 1] &&
      !cur.softCut &&
      !prev.softCut &&
      cur.text.length < 60 &&
      prev.text.length + cur.text.length + 2 <= budget
    ) {
      prev.text = `${prev.text}\n\n${cur.text}`;
      prev.charEnd = cur.charEnd;
      chunks.splice(i, 1);
      chunkHeading.splice(i, 1);
      i--;
    }
  }

  return chunks.map((c) => ({ ...c, text: c.text.trim() }));
}
