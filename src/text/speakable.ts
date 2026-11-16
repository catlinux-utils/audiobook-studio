/**
 * Synthesis-text normalization: ALL-CAPS headings ("ROZDZIAŁ 7",
 * "PRZEKLEŃSTWO MASZYNY") read badly through the TTS model and garble the
 * word-check ASR. Stored chapter text is never changed — this runs only on
 * the text sent to the synthesizer.
 *
 * Fully-capitalized words (≥ 4 letters) are converted to sentence case:
 *   ROZDZIAŁ → Rozdział, MASZYNY → Maszyny
 * Shorter capitals are likely acronyms (USA, ONZ, PRL) and are left alone,
 * as are mixed-case words, single letters and digits.
 */

const WORD_RE = /\p{L}+/gu; // unicode letter runs (handles Ł, Ą, Ń, …)

export function speakableCase(text: string): string {
  return text.replace(WORD_RE, (word) => {
    if (word.length < 4) return word;
    // only touch words where every letter is uppercase
    if (word !== word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}
