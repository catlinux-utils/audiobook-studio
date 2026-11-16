import { describe, expect, it } from 'vitest';
import { splitTxtChapters } from '../src/ingest/txt.js';

const body = (n: number) => `To jest akapit numer ${n}. `.repeat(10).trim();

describe('splitTxtChapters', () => {
  it('keeps keyword headings working', () => {
    const t = `Rozdział 1. Początek\n\n${body(1)}\n\nRozdział 2. Koniec\n\n${body(2)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['Rozdział 1. Początek', 'Rozdział 2. Koniec']);
  });

  it('splits a book that uses only bare roman numerals', () => {
    const t = `Trzej Muszkieterowie\n\n${body(1)}\n\nI.\n\n${body(2)}\n\nXXIV.\n\n${body(3)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['Rozdział I', 'Rozdział XXIV']);
  });

  it('merges an ALL CAPS title on the line after a numeral', () => {
    const t = `${body(1)}\n\nXXIV.\n\nNA JEDEN DZIEŃ\n\n${body(2)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe('Rozdział XXIV. NA JEDEN DZIEŃ');
    expect(chapters[0]!.text).not.toContain('NA JEDEN DZIEŃ');
    expect(chapters[0]!.text).toContain(body(2).slice(0, 20));
  });

  it('handles numeral and title on the same line (Musketeers style)', () => {
    const t = `${body(1)}\n\nXXIV. NA JEDEN DZIEŃ\n\n${body(2)}\n\nXXV. KAMIZELKA CZERWONA\n\n${body(3)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['XXIV. NA JEDEN DZIEŃ', 'XXV. KAMIZELKA CZERWONA']);
    expect(chapters[0]!.text).not.toContain('KAMIZELKA');
  });

  it('handles arabic numerals with inline title', () => {
    const t = `${body(1)}\n\n12. Odjazd\n\n${body(2)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['12. Odjazd']);
  });

  it('does not treat a sentence-like line after a numeral as a heading', () => {
    const t = `${body(1)}\n\nI.\n\n${body(2)}\n\n${body(3)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['Rozdział I']);
    expect(chapters[0]!.text).toContain(body(2));
  });

  it('ignores a stray numeral in the preamble when not blank-line separated', () => {
    const t = `Tytuł książki\n1863 rok\n\n${body(1)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe('Całość');
  });

  it('falls back to a single chapter when nothing looks like a heading', () => {
    const t = `${body(1)}\n\n${body(2)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters).toEqual([{ title: 'Całość', text: t.trim() }]);
  });

  it('keeps the preamble as Wstęp for numeral-only books', () => {
    const preamble = Array.from({ length: 8 }, (_, k) => `Linia przedmowy numer ${k} z kilkoma słowami.`).join('\n');
    const t = `${preamble}\n\nI.\n\n${body(1)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters[0]!.title).toBe('Wstęp');
    expect(chapters[1]!.title).toBe('Rozdział I');
  });

  it('normalizes CRLF line endings', () => {
    const t = `Rozdział 1.\r\n\r\n${body(1)}\r\n\r\nRozdział 2.\r\n\r\n${body(2)}`;
    const chapters = splitTxtChapters(t);
    expect(chapters.map((c) => c.title)).toEqual(['Rozdział 1.', 'Rozdział 2.']);
  });
});
