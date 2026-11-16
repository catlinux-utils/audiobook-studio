import { describe, expect, it } from 'vitest';
import { speakableCase } from '../src/text/speakable.js';

describe('speakableCase', () => {
  it('sentence-cases long ALL-CAPS words', () => {
    expect(speakableCase('ROZDZIAŁ 7\n\nPRZEKLEŃSTWO MASZYNY')).toBe('Rozdział 7\n\nPrzekleństwo Maszyny');
  });

  it('leaves short all-caps words (acronyms) alone', () => {
    expect(speakableCase('USA I ONZ W PRL')).toBe('USA I ONZ W PRL');
  });

  it('leaves mixed-case and lowercase words alone', () => {
    expect(speakableCase('Ala ma kota i McDonald`s')).toBe('Ala ma kota i McDonald`s');
  });

  it('leaves digits and single letters alone', () => {
    expect(speakableCase('ROZDZIAŁ 7 A')).toBe('Rozdział 7 A');
  });

  it('keeps punctuation and structure', () => {
    expect(speakableCase('CZĘŚĆ I: POCZĄTEK!')).toBe('Część I: Początek!');
  });

  it('handles roman numerals in headings (short caps stay)', () => {
    expect(speakableCase('ROZDZIAŁ XI')).toBe('Rozdział XI');
  });
});
