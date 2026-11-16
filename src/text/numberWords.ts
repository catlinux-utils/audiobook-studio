/**
 * Digit ↔ Polish number-word equivalence for the word-check diff. The ASR
 * hears "7" as "siedem" (cardinal) or "siódmy" (ordinal) — neither is an
 * edit-distance match, so headings like "Rozdział 7" would always flag.
 */

const CARDINALS: Record<string, string[]> = {
  '0': ['zero'],
  '1': ['jeden', 'jedna', 'jedno'],
  '2': ['dwa', 'dwie'],
  '3': ['trzy'],
  '4': ['cztery'],
  '5': ['pięć'],
  '6': ['sześć'],
  '7': ['siedem'],
  '8': ['osiem'],
  '9': ['dziewięć'],
  '10': ['dziesięć'],
  '11': ['jedenaście'],
  '12': ['dwanaście', 'dwadzieścia'],
  '13': ['trzynaście'],
  '14': ['czternaście'],
  '15': ['piętnaście'],
  '16': ['szesnaście'],
  '17': ['siedemnaście'],
  '18': ['osiemnaście'],
  '19': ['dziewiętnaście'],
  '20': ['dwadzieścia'],
};

const ORDINAL_STEMS: Record<string, string[]> = {
  '1': ['pierwsz'],
  '2': ['drug'],
  '3': ['trzec'],
  '4': ['czwart'],
  '5': ['piąt'],
  '6': ['szóst'],
  '7': ['siód'],
  '8': ['ósm'],
  '9': ['dziewiąt'],
  '10': ['dziesiąt'],
  '11': ['jedenast'],
  '12': ['dwunast'],
  '13': ['trzynast'],
  '14': ['czternast'],
  '15': ['piętnast'],
  '16': ['szesnast'],
  '17': ['siedemnast'],
  '18': ['osiemnast'],
  '19': ['dziewiętnast'],
  '20': ['dwudziest'],
};

const ORDINAL_ENDINGS = /^(y|a|e|o|ego|ej|emu|ym|ą|ych|ie)$/;

function isDigitWord(w: string): boolean {
  return /^\d+$/.test(w);
}

function formsFor(digit: string): Set<string> {
  const out = new Set<string>(CARDINALS[digit] ?? []);
  for (const stem of ORDINAL_STEMS[digit] ?? []) {
    out.add(stem); // "siód-" with tolerance for truncated endings
    for (const end of ['y', 'a', 'e', 'ego', 'ej', 'emu', 'ym', 'my', 'ych', 'ą', 'ma']) out.add(stem + end);
  }
  return out;
}

/** True when one token is a digit and the other is its Polish number word
 *  (cardinal or ordinal form, any gender). */
export function sameNumber(a: string, b: string): boolean {
  const digit = isDigitWord(a) ? a : isDigitWord(b) ? b : null;
  if (!digit || digit.length > 2) return false;
  const word = isDigitWord(a) ? b : a;
  if (isDigitWord(word)) return word === digit;
  return formsFor(digit).has(word);
}
