// Arabic text normalization for search and matching.
//
// We never show normalized text to users: it only feeds the tsvector column,
// the mock embedder and keyword matching, so that "إستلام", "استلام" and
// "اسْتِلام" all hit the same documents.

const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g;
const TATWEEL = /\u0640/g;
const ARABIC_CHAR = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_CHAR = /[A-Za-z]/g;

const CHAR_MAP: Record<string, string> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا',
  'ى': 'ي', 'ی': 'ي', 'ئ': 'ي',
  'ؤ': 'و',
  'ة': 'ه',
  'ک': 'ك',
};

/** Normalize Arabic (and mixed) text for indexing and matching. */
export function normalizeArabic(input: string): string {
  let s = input.normalize('NFKC').replace(TASHKEEL, '').replace(TATWEEL, '');
  s = s.replace(/[\u0623\u0625\u0622\u0671\u0649\u06CC\u0626\u0624\u0629\u06A9]/g, (c) => CHAR_MAP[c] ?? c);
  // Arabic-Indic (٠-٩) and Extended/Persian (۰-۹) digits -> ASCII
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // Arabic punctuation -> ASCII equivalents
  s = s.replace(/،/g, ',').replace(/؛/g, ';').replace(/؟/g, '?');
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export type Script = 'ar' | 'en' | 'arabizi' | 'mixed' | 'unknown';

// Arabizi ("3ayez a7gez", "ma3lesh") writes Arabic in Latin letters using
// digits for sounds with no Latin equivalent (3=ع, 7=ح, 5=خ, 2=ء, 9=ق/ص).
// Requires letters around the digit ("sa3a", "a7gez") or 3+ letters after a
// leading digit ("3ayez"), so "8pm", "2nd" or "5kg" are not mistaken for Arabizi.
const ARABIZI_TOKEN = /\b[a-z]+[2357896][a-z]+\b|\b[2357896][a-z]{3,}\b/i;
const ARABIZI_WORDS = /\b(yalla|inshallah|habibi|shukran|mashallah|ya3ni|khalas|mesh|msh|ana|enta|enti|ezay|keda|wallah|3ayez|3awz)\b/i;

/** Cheap script detection used to pick the reply language and FTS config. */
export function detectScript(text: string): Script {
  const ar = text.match(ARABIC_CHAR)?.length ?? 0;
  const lat = text.match(LATIN_CHAR)?.length ?? 0;
  if (ar === 0 && lat === 0) return 'unknown';
  if (ar > 0 && lat > 0) {
    const ratio = ar / (ar + lat);
    if (ratio > 0.7) return 'ar';
    if (ratio < 0.3) return lat > 0 && looksArabizi(text) ? 'arabizi' : 'en';
    return 'mixed';
  }
  if (ar > 0) return 'ar';
  return looksArabizi(text) ? 'arabizi' : 'en';
}

function looksArabizi(text: string): boolean {
  return ARABIZI_TOKEN.test(text) || ARABIZI_WORDS.test(text);
}

/** Whether the UI should render this text right-to-left. */
export function isRtl(text: string): boolean {
  const s = detectScript(text);
  return s === 'ar' || (s === 'mixed' && (text.match(ARABIC_CHAR)?.length ?? 0) >= (text.match(LATIN_CHAR)?.length ?? 0));
}
