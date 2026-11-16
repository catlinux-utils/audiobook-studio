import { describe, expect, it } from 'vitest';
import { sameNumber } from '../src/text/numberWords.js';

describe('sameNumber', () => {
  it('digits match cardinal number words', () => {
    expect(sameNumber('7', 'siedem')).toBe(true);
    expect(sameNumber('siedem', '7')).toBe(true);
    expect(sameNumber('12', 'dwanaście')).toBe(true);
  });

  it('digits match ordinal number words', () => {
    expect(sameNumber('7', 'siódmy')).toBe(true);
    expect(sameNumber('7', 'siódma')).toBe(true);
    expect(sameNumber('1', 'pierwszego')).toBe(true);
    expect(sameNumber('10', 'dziesiąt')).toBe(true);
  });

  it('digit matches itself', () => {
    expect(sameNumber('7', '7')).toBe(true);
    expect(sameNumber('7', '8')).toBe(false);
  });

  it('non-number words never match', () => {
    expect(sameNumber('7', 'maszyny')).toBe(false);
    expect(sameNumber('rozdział', 'siedem')).toBe(false);
    expect(sameNumber('1945', 'rok')).toBe(false); // long digits out of scope
  });

  it('numbers never match a different digit', () => {
    expect(sameNumber('7', 'osiem')).toBe(false);
    expect(sameNumber('7', 'siódmya')).toBe(false);
  });
});
