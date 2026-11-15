import { describe, expect, it } from 'vitest';
import { chunkText, splitSentences, normalizeText } from '../src/ingest/chunker.js';

describe('normalizeText', () => {
  it('collapses intra-paragraph whitespace, keeps paragraph breaks', () => {
    const out = normalizeText('Pierwszy   wiersz\nzawija  się.\n\nDrugi akapit.');
    expect(out).toBe('Pierwszy wiersz\nzawija się.\n\nDrugi akapit.');
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    const s = splitSentences('Ala ma kota. Kot ma Alę! Co na to Pan Bóg?');
    expect(s).toHaveLength(3);
    expect(s[0]!.text).toBe('Ala ma kota.');
    expect(s[2]!.text).toBe('Co na to Pan Bóg?');
  });

  it('does not split on Polish abbreviations', () => {
    const s = splitSentences('Mieszka przy ul. Kwiatowej prof. Kowalskiego. To wiadomo.');
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain('ul. Kwiatowej');
  });

  it('does not split on initials', () => {
    const s = splitSentences('Napisała to J. K. Rowling w 1997 roku. Później przeszła do historii.');
    expect(s).toHaveLength(2);
    expect(s[0]!.text).toContain('J. K. Rowling w 1997');
  });

  it('keeps decimals together', () => {
    const s = splitSentences('Wartość pi wynosi 3.14 w przybliżeniu. Dokładniej jest inaczej.');
    expect(s).toHaveLength(2);
  });

  it('keeps dialogue dashes inside sentences', () => {
    const s = splitSentences('— Nie wierzę — powiedziała. — Ale widziałem to!');
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s[0]!.text.startsWith('—')).toBe(true);
  });

  it('treats ellipsis as a boundary', () => {
    const s = splitSentences('Czekał długo… aż w końcu przyszedł. I wtedy zamilkł.');
    expect(s).toHaveLength(2);
  });
});

describe('chunkText', () => {
  it('packs sentences up to maxChars without splitting sentences', () => {
    const text = 'Pierwsze krótkie zdanie. Drugie krótkie zdanie. Trzecie krótkie zdanie. Czwarte krótkie zdanie.';
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(60);
      expect(c.softCut).toBe(false);
      expect(c.text.endsWith('.')).toBe(true);
    }
    // offsets must map back to the original text
    for (const c of chunks) {
      expect(text.slice(c.charStart, c.charEnd).replace(/\s+/g, ' ').trim()).toBe(c.text.replace(/\s+/g, ' ').trim());
    }
  });

  it('soft-cuts an over-long sentence at inner punctuation and flags it', () => {
    const longSentence =
      'Wielki księga opowiadała o dawnych czasach, o bitwach i zdradach, o miłości, która przetrwała wszystko, i o końcu świata.';
    const chunks = chunkText(longSentence, 60);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.some((c) => c.softCut)).toBe(true);
    // reassembly must preserve all words
    const rejoined = chunks.map((c) => c.text).join(' ');
    expect(rejoined.replace(/\s+/g, ' ')).toContain('o dawnych czasach');
    expect(rejoined).toContain('końcu świata.');
  });

  it('returns empty for blank input', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('handles a whole Polish paragraph with dialogue and abbreviation', () => {
    const text =
      '— Panie prof., czy to prawda? — zapytała cicho.\n\n— Prawda — odparł po chwili. Reszta jest już historią, którą znacie z książek, filmów, opowieści, legend, przekazów i plotek.';
    const chunks = chunkText(text, 120);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const all = chunks.map((c) => c.text).join(' ');
    expect(all).toContain('Panie prof.');
    expect(all).toContain('plotek.');
  });
});
