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
 * Pack sentences into chunks of at most `maxChars` characters.
 * Paragraph structure (\n\n) inside chunks is preserved verbatim.
 */
export function chunkText(text: string, maxChars = 280): TextChunk[] {
  const clean = normalizeText(text);
  if (!clean.trim()) return [];
  const budget = Math.max(60, maxChars);
  const sentences = splitSentences(clean);
  const chunks: TextChunk[] = [];

  let current: Array<{ text: string; start: number; end: number }> = [];
  let currentLen = 0;

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
    current = [];
    currentLen = 0;
  };

  for (const sentence of sentences) {
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
      }
      continue;
    }
    if (currentLen + sentence.text.length > budget && current.length > 0) {
      flush();
    }
    current.push(sentence);
    currentLen += sentence.text.length;
  }
  flush();
  return chunks.map((c) => ({ ...c, text: c.text.trim() }));
}
