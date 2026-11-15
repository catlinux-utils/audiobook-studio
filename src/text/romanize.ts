/**
 * Romanization for the MMS forced aligner (text_normalization=pre_romanized).
 *
 * MMS-300M covers 1,130 languages acoustically but the audio.cpp port only
 * normalizes Dutch/English natively; everything else must arrive as
 * caller-supplied ASCII ("pre_romanized"). Polish is Latin-script, so the
 * mapping is a simple diacritic fold — 1:1 per word, so aligned timestamps
 * map straight back onto the original tokens.
 */

const PL_MAP: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
};

/** Split a transcript into word tokens the same way the aligner will see them. */
export function transcriptTokens(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[^\s]/.test(w));
}

/** Romanize one word: fold diacritics, keep only ASCII letters/digits/'/- . */
export function romanizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => PL_MAP[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // any remaining combining marks
    .replace(/[^a-z0-9'’-]/g, '')
    .replace(/[’]/g, "'");
}

/** Romanize a whole transcript, preserving token order and count. */
export function romanizeTokens(tokens: string[]): string[] {
  return tokens.map(romanizeWord);
}
