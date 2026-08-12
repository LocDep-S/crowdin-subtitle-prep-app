/**
 * Turns a literal transcript-style .srt (one cue per whatever a transcription
 * tool happened to segment - often far too long/dense, sometimes far too
 * fragmented) into something closer to a real subtitle file, following the
 * broad strokes that Netflix's Timed Text Style Guide and the BBC Subtitle
 * Guidelines agree on: a max line length and line count, a max reading speed
 * (characters/second), a minimum/maximum cue duration, a minimum gap between
 * cues, and breaking at grammatical boundaries rather than mid-word.
 *
 * This is a heuristic v1, not a linguistic tool - it can't know that a long
 * cue's natural break is after "...but then," rather than after the next
 * comma; it can only apply the same punctuation-first, then-comma, then
 * word-boundary fallback rule everywhere. Anything it can't resolve cleanly
 * (chiefly: source dialogue that's just genuinely too dense for the target
 * reading speed within its own real-world duration) is reported back in
 * `warnings` rather than silently forced - duration comes from the original
 * audio timing, so this engine can shrink/merge/split cues, but it can never
 * invent more time than the speaker actually took.
 *
 * Multi-language support: everything numeric/structural is language-agnostic
 * and works the same regardless of source language. A handful of heuristics
 * are inherently language-specific (which words are disfluencies, which
 * short phrases are droppable filler, which words are "weak" to end a
 * line/cue on, which parenthetical markers mean voice-over) - those live in
 * per-language tables below, currently covering English (en), French (fr),
 * German (de), Spanish (es), and Brazilian Portuguese (pt-BR). An
 * unrecognized/missing `language` setting falls back to English.
 */

const PRESETS = {
   netflix: {
        label: "Netflix Timed Text Style Guide",
        maxCharsPerLine: 42,
        maxLines: 2,
        targetCps: 20,
        minDurationMs: 833,
        maxDurationMs: 7000,
        minGapMs: 83,
        gapDeadZoneMs: 500,
        outTimeBufferMs: 500,
   },
   bbc: {
        label: "BBC Subtitle Guidelines",
        maxCharsPerLine: 37,
        maxLines: 2,
        targetCps: 15,
        minDurationMs: 1000,
        maxDurationMs: 7000,
        minGapMs: 80,
        gapDeadZoneMs: 80,
        outTimeBufferMs: 0,
   },
};

const LANGUAGES = {
   en: "English",
   fr: "French",
   de: "German",
   es: "Spanish",
   "pt-BR": "Portuguese (Brazil)",
};
const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

const DEFAULT_SETTINGS = {
   preset: "netflix",
   ...PRESETS.netflix,
   stripDisfluencies: true,
   language: "en",
};

function resolveSettings(userSettings = {}) {
   const base = PRESETS[userSettings.preset] || PRESETS.netflix;
   const merged = {
        ...DEFAULT_SETTINGS,
        ...base,
        ...userSettings,
   };
   if (!SUPPORTED_LANGUAGES.includes(merged.language)) merged.language = "en";
   return merged;
}

// ---------------------------------------------------------------------------
// Unicode-safe word boundaries
// ---------------------------------------------------------------------------
// JS's built-in \b is defined in terms of \w, which is ASCII-only (A-Za-z0-9_)
// - it does NOT treat accented letters (e, a, n, a, c...) as word characters.
// That means \bword\b silently fails to match at a boundary that sits right
// next to an accented letter - not an error, just a quiet non-match, which is
// worse. atWordEdge builds the equivalent check using \p{L}/\p{N} (Unicode
// letter/number categories) instead, so this works the same for accented
// text in fr/de/es/pt-BR as it does for English.
function atWordEdge(pattern) {
   return `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`;
}

function stripNonWordChars(word) {
   return word.replace(/[^\p{L}\p{N}']/gu, "");
}

// ---------------------------------------------------------------------------
// Disfluency stripping
// ---------------------------------------------------------------------------
// Deliberately conservative: only tokens that are almost never meaningful
// content on their own (um, uh, erm, hmm...) and immediate word-repetition
// stutters ("I I I want" -> "I want"). Filler words that frequently carry
// real meaning or register in context are intentionally NOT touched. Same
// philosophy applied to the other languages' lists below: only near-
// meaningless hesitation sounds, never words that double as real content.
const FILLER_WORDS_BY_LANG = {
   en: ["um+", "uh+", "erm+", "hmm+", "mhm+", "uh-huh", "uh-uh"],
   fr: ["euh+", "heu+", "hum+"],
   de: ["ähm+", "äh+", "öhm+", "hm+"],
   es: ["eh+", "ehm+", "em+", "mmm+"],
   "pt-BR": ["ahn+", "hum+", "eh+"],
};

function fillerRegexFor(lang) {
   const words = FILLER_WORDS_BY_LANG[lang] || FILLER_WORDS_BY_LANG.en;
   return new RegExp(`${atWordEdge(`(?:${words.join("|")})`)}[,.]?`, "giu");
}

function normalizeToken(tok) {
   return tok.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function collapseStutters(text) {
   const tokens = text.split(/\s+/).filter(Boolean);
   let i = 0;
   while (i < tokens.length) {
        let collapsedHere = false;
        for (let w = Math.min(3, Math.floor((tokens.length - i) / 2)); w >= 1; w--) {
               const a = tokens.slice(i, i + w).map(normalizeToken).join(" ");
               const b = tokens.slice(i + w, i + 2 * w).map(normalizeToken).join(" ");
               if (a && a === b) {
                        tokens.splice(i + w, w);
                        collapsedHere = true;
                        break;
               }
        }
        if (!collapsedHere) i++;
   }
   return tokens.join(" ");
}

function stripDisfluencies(text, lang = "en") {
   let out = text.replace(fillerRegexFor(lang), "");
   out = collapseStutters(out);
   out = out
     .replace(/[ \t]{2,}/g, " ")
     .replace(/\s+([,.!?])/g, "$1")
     .replace(/^[,\s]+/, "")
     .replace(/\n[ \t]+/g, "\n")
     .trim();
   return out;
}

// ---------------------------------------------------------------------------
// Density rescue: dropping filler phrases and trailing hedge clauses
// ---------------------------------------------------------------------------
// Unlike stripDisfluencies() above (which always runs on every cue), these
// only get tried on a cue that is STILL reading too fast for its final
// duration after splitting and duration extension have already done
// everything they can. They're deliberately narrow - each phrase is only
// removed when it's set off by a comma or the very start/end of the cue
// (never mid-clause). The fr/de/es/pt-BR lists are direct, conservative
// equivalents of the English ones.
const MID_FILLER_PHRASES_BY_LANG = {
   en: ["you know", "i mean", "basically", "honestly", "to be honest"],
   fr: ["tu vois", "je veux dire", "en gros", "honnêtement", "pour être honnête"],
   de: ["weißt du", "ich meine", "im grunde", "ehrlich gesagt", "um ehrlich zu sein"],
   es: ["sabes", "quiero decir", "basicamente", "honestamente", "para ser honesto"],
   "pt-BR": ["sabe", "quero dizer", "basicamente", "honestamente", "para ser honesto"],
};
const TRAILING_CLAUSES_BY_LANG = {
   en: ["you know what i mean", "if that makes sense", "if you will", "or something", "or whatever"],
   fr: ["si tu vois ce que je veux dire", "si on veut", "ou je ne sais quoi", "ou quoi"],
   de: ["weißt du was ich meine", "wenn man so will", "oder was auch immer", "oder so"],
   es: ["sabes lo que quiero decir", "si se quiere", "o lo que sea", "o algo así"],
   "pt-BR": ["sabe o que eu quero dizer", "ou seja lá o que for", "se você quiser", "ou algo assim"],
};

function capitalizeFirst(text) {
   return text.replace(/^(\s*)(\p{Ll})/u, (m, lead, ch) => lead + ch.toUpperCase());
}

function stripFillerPhrases(text, lang = "en") {
   const phrases = MID_FILLER_PHRASES_BY_LANG[lang] || MID_FILLER_PHRASES_BY_LANG.en;
   let out = text;
   for (const phrase of phrases) {
        const p = phrase.replace(/ /g, "\\s+");
        const re = new RegExp(`(^|,\\s*)${atWordEdge(p)}\\s*(,\\s*|[.!?]|$)`, "giu");
        out = out.replace(re, (match, lead, trail) => {
               if (lead === "") return "";
               if (trail === "" || /[.!?]$/.test(trail)) return trail;
               return ", ";
        });
   }
   out = out
     .replace(/\s+/g, " ")
     .replace(/\s+([,.!?])/g, "$1")
     .replace(/,\s*,/g, ",")
     .replace(/^[,\s]+/, "")
     .trim();
   return capitalizeFirst(out);
}

function stripTrailingClause(text, lang = "en") {
   const phrases = TRAILING_CLAUSES_BY_LANG[lang] || TRAILING_CLAUSES_BY_LANG.en;
   let out = text;
   for (const phrase of phrases) {
        const p = phrase.replace(/ /g, "\\s+");
        const re = new RegExp(`,\\s*${p}\\s*([.!?]?)\\s*$`, "iu");
        out = out.replace(re, "$1");
   }
   return out.replace(/\s+([,.!?])/g, "$1").trim();
}

// ---------------------------------------------------------------------------
// Formatting conventions (ellipses, ALL-CAPS sources, italics markers)
// ---------------------------------------------------------------------------

function normalizeEllipsis(text) {
   return text.replace(/\.(?:\s?\.){2,}/g, "…");
}

const ACRONYM_WHITELIST = [
   "OK", "TV", "FBI", "CIA", "US", "UK", "EU", "UN", "CEO", "CFO", "AI", "DNA",
   "NASA", "ID", "PHD", "ATM", "GPS", "VIP", "DJ", "MC", "FYI", "ASAP", "DIY",
 ];

// Unicode-aware so an accented ALL-CAPS source (French/German/Spanish/
// Portuguese transcripts routinely have accented capitals) gets counted
// correctly instead of only recognizing plain A-Z.
function looksAllCaps(cues) {
   let upper = 0;
   let letters = 0;
   for (const c of cues) {
        for (const ch of c.text) {
               if (/\p{L}/u.test(ch)) {
                        letters += 1;
                        if (/\p{Lu}/u.test(ch)) upper += 1;
               }
        }
   }
   return letters > 20 && upper / letters > 0.85;
}

function toSentenceCase(text, lang = "en") {
   let out = text.toLowerCase();
   out = out.replace(/(^\s*|[.!?]\s+)(\p{Ll})/gu, (m, pre, ch) => pre + ch.toUpperCase());
   // The standalone-"i"-is-always-capitalized rule is English-specific.
  if (lang === "en") {
       out = out.replace(/\bi\b/g, "I").replace(/\bi'(m|ll|ve|d)\b/g, (m) => "I'" + m.slice(2));
  }
   for (const acr of ACRONYM_WHITELIST) {
        out = out.replace(new RegExp(`\\b${acr.toLowerCase()}\\b`, "g"), acr);
   }
   return out;
}

const VO_MARKER_RE_BY_LANG = {
   en: /^\s*[([]\s*(?:v\.?\s?o\.?|voice[\s-]?over|narrat(?:ion|ing))\s*[)\]]\s*[:\-]?\s*/i,
   fr: /^\s*[([]\s*(?:voix\s?off|narration)\s*[)\]]\s*[:\-]?\s*/i,
   de: /^\s*[([]\s*(?:off|voice[\s-]?over|erz[äa]hler(?:in)?)\s*[)\]]\s*[:\-]?\s*/i,
   es: /^\s*[([]\s*(?:voz\s?en\s?off|narraci[óo]n)\s*[)\]]\s*[:\-]?\s*/i,
   "pt-BR": /^\s*[([]\s*(?:voz\s?em\s?off|narra[çc][aã]o)\s*[)\]]\s*[:\-]?\s*/i,
};
const SONG_MARK_RE = /[♪♫]/;

function extractItalicsMarker(text, lang = "en") {
   const voRe = VO_MARKER_RE_BY_LANG[lang] || VO_MARKER_RE_BY_LANG.en;
   const voMatch = voRe.exec(text);
   if (voMatch) {
        return { text: text.slice(voMatch[0].length).trim(), italic: true };
   }
   if (SONG_MARK_RE.test(text)) {
        return { text, italic: true };
   }
   return { text, italic: false };
}

// ---------------------------------------------------------------------------
// Speaker label detection (for speaker-dash formatting)
// ---------------------------------------------------------------------------

// Matches a leading "Name: " / "JANE: " / "Dr. Smith: " label - one to three
// capitalized words followed by a colon, a space, and more text. Unicode-
// aware (\p{Lu}/\p{L}) so accented names (François, Ángela, Björn...) are
// recognized the same as plain-ASCII ones.
const SPEAKER_LABEL_RE = /^\s*([\p{Lu}][\p{L}.'-]{0,20}(?:\s[\p{Lu}][\p{L}.'-]{0,20}){0,2}):\s+(?=\S)/u;

function normalizeSpeakerLabel(label) {
   return label.trim().toUpperCase();
}

function detectSpeakerLabels(rawCues) {
   const counts = new Map();
   let matches = 0;
   for (const c of rawCues) {
        const m = SPEAKER_LABEL_RE.exec(c.text);
        if (m) {
               matches += 1;
               const key = normalizeSpeakerLabel(m[1]);
               counts.set(key, (counts.get(key) || 0) + 1);
        }
   }
   const recurring = [...counts.values()].filter((n) => n >= 2).length;
   const confident = recurring >= 2 && matches >= 4 && matches / Math.max(rawCues.length, 1) >= 0.3;
   return { confident, counts };
}

// ---------------------------------------------------------------------------
// Line wrapping (within one cue)
// ---------------------------------------------------------------------------

function wrapLines(text, maxCharsPerLine) {
   const words = text.split(/\s+/).filter(Boolean);
   const lines = [];
   let current = "";
   for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxCharsPerLine || !current) {
               current = candidate;
        } else {
               lines.push(current);
               current = word;
        }
   }
   if (current) lines.push(current);
   return lines;
}

// Articles/prepositions/conjunctions/possessives/demonstratives that
// shouldn't be stranded at the end of a line or a cue-to-cue split. English
// list is unchanged from before; fr/de/es/pt-BR are direct equivalents.
const WEAK_END_WORDS_BY_LANG = {
   en: new Set([
        "a", "an", "the",
        "in", "on", "at", "to", "of", "for", "with", "by", "from", "as", "into",
        "onto", "upon", "about", "over", "under", "between", "through", "during",
        "before", "after", "above", "below", "without", "within", "near", "since",
        "until", "unless", "though", "although", "against", "among", "across",
        "behind", "beside", "beyond", "along", "around", "toward", "towards", "per",
        "and", "but", "or", "nor", "so", "yet", "because", "if", "when", "while",
        "whereas", "than", "that",
        "my", "your", "his", "her", "its", "our", "their", "this", "these", "those",
      ]),
   fr: new Set([
        "le", "la", "les", "l'", "un", "une", "des", "de", "du",
        "à", "au", "aux", "en", "dans", "sur", "sous", "avec", "sans", "pour",
        "par", "entre", "chez", "vers", "et", "ou", "mais", "donc", "car", "ni",
        "or", "que", "qui", "quand", "comme", "si", "y",
        "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
        "notre", "nos", "votre", "vos", "leur", "leurs", "ce", "cet", "cette", "ces",
      ]),
   de: new Set([
        "der", "die", "das", "den", "dem", "des",
        "ein", "eine", "einen", "einem", "einer", "eines",
        "und", "oder", "aber", "doch", "denn", "dass", "wenn", "weil", "als", "wie",
        "in", "an", "auf", "aus", "bei", "mit", "nach", "seit", "von", "zu", "für",
        "gegen", "ohne", "um", "durch",
        "im", "am", "zum", "zur", "vom",
        "mein", "dein", "sein", "ihr", "unser", "euer",
      ]),
   es: new Set([
        "el", "la", "los", "las", "un", "una", "unos", "unas",
        "de", "del", "a", "al", "en", "con", "sin", "por", "para", "entre", "sobre",
        "y", "o", "pero", "que", "si", "cuando", "como",
        "mi", "tu", "su", "nuestro", "nuestra", "vuestro", "vuestra",
        "este", "esta", "estos", "estas", "ese", "esa",
      ]),
   "pt-BR": new Set([
        "o", "a", "os", "as", "um", "uma", "uns", "umas",
        "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
        "com", "sem", "por", "para", "entre", "sobre", "e", "ou", "mas", "que",
        "se", "quando", "como", "ao", "aos", "à", "às",
        "meu", "minha", "teu", "tua", "seu", "sua", "nosso", "nossa",
        "este", "esta", "estes", "estas",
      ]),
};

function endsWeak(word, lang = "en") {
   const set = WEAK_END_WORDS_BY_LANG[lang] || WEAK_END_WORDS_BY_LANG.en;
   const clean = stripNonWordChars(word.toLowerCase());
   return set.has(clean);
}

function looksLikeNamePair(wordA, wordB) {
   const isCap = (w) => /^[\p{Lu}][\p{Ll}]/u.test(w);
   return isCap(wordA) && isCap(wordB) && !/[.!?,;:]$/.test(wordA);
}

function scoreSplit(words, splitIdx, maxCharsPerLine, lang) {
   const line1 = words.slice(0, splitIdx).join(" ");
   const line2 = words.slice(splitIdx).join(" ");
   if (line1.length > maxCharsPerLine || line2.length > maxCharsPerLine) return Infinity;

   let score = 0;
   const diff = line1.length - line2.length;
   score += Math.max(0, diff) * 1.2;
   score += Math.abs(diff) * 0.15;

   const lastWordL1 = words[splitIdx - 1];
   if (endsWeak(lastWordL1, lang)) score += 40;
   if (looksLikeNamePair(words[splitIdx - 1], words[splitIdx])) score += 60;
   if (/[.!?]$/.test(lastWordL1)) score -= 20;
   else if (/[,;:]$/.test(lastWordL1)) score -= 10;

   return score;
}

function wrapLinesSmart(text, maxCharsPerLine, lang = "en") {
   const words = text.split(/\s+/).filter(Boolean);
   if (!words.length) return [];
   const greedy = wrapLines(text, maxCharsPerLine);
   if (greedy.length !== 2) return greedy;

   let best = null;
   let bestScore = Infinity;
   for (let i = 1; i < words.length; i++) {
        const s = scoreSplit(words, i, maxCharsPerLine, lang);
        if (s < bestScore) {
               bestScore = s;
               best = i;
        }
   }
   if (best === null) return greedy;
   return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}


// ---------------------------------------------------------------------------
// Splitting overly long/dense text into N chunks at natural boundaries
// ---------------------------------------------------------------------------

// The word immediately before `idx` in `text` (no trailing punctuation/whitespace).
// Unicode-aware (\p{L}) so accented words (French "etre", Portuguese "nao"...)
// come back whole instead of having their accented character truncate the
// match early.
function wordBeforeIndex(text, idx) {
   const before = text.slice(0, idx).replace(/[^\p{L}']+$/u, "");
   const m = /[\p{L}']+$/u.exec(before);
   return m ? m[0] : "";
}

// The word immediately at/after `idx` in `text` (no leading punctuation/whitespace).
function wordAfterIndex(text, idx) {
   const m = /^[\p{L}']+/u.exec(text.slice(idx));
   return m ? m[0] : "";
}

// Break points ranked by strength: sentence end (0), comma/semicolon/colon
// (1), any word boundary (2, always a fallback).
function findBreakPoints(text, lang = "en") {
   const byIndex = new Map();
   const patterns = [
        [/[.!?]+\s+/g, 0],
        [/[,;:]\s+/g, 1],
        [/\s+/g, 2],
      ];
   for (const [re, priority] of patterns) {
        let m;
        while ((m = re.exec(text))) {
               const idx = m.index + m[0].length;
               if (!byIndex.has(idx) || byIndex.get(idx) > priority) byIndex.set(idx, priority);
        }
   }
   return [...byIndex.entries()]
     .map(([index, priority]) => ({
            index,
            priority,
            weakEnd: endsWeak(wordBeforeIndex(text, index), lang),
            namePair: looksLikeNamePair(wordBeforeIndex(text, index), wordAfterIndex(text, index)),
     }))
     .sort((a, b) => a.index - b.index);
}

// Split `text` into exactly `n` roughly-equal chunks, cutting at the break
// point closest to each absolute target, weighted by boundary strength and
// penalized for ending a chunk right after a weak word.
function splitIntoChunks(text, n, lang = "en") {
   if (n <= 1) return [text];
   const points = findBreakPoints(text, lang);
   const cuts = [];
   let start = 0;
   const scoreOf = (p, target) => Math.abs(p.index - target) + p.priority * 6 + (p.weakEnd ? 10 : 0) + (p.namePair ? 15 : 0);
   for (let i = 1; i < n; i++) {
        const target = Math.round((i * text.length) / n);
        const candidates = points.filter((p) => p.index > start && p.index < text.length);
        if (!candidates.length) break;
        let best = candidates[0];
        let bestScore = scoreOf(best, target);
        for (const c of candidates) {
               const score = scoreOf(c, target);
               if (score < bestScore) {
                        best = c;
                        bestScore = score;
               }
        }
        const cut = Math.max(start + 1, best.index);
        cuts.push(cut);
        start = cut;
   }
   const bounds = [0, ...cuts, text.length];
   const chunks = [];
   for (let i = 0; i < bounds.length - 1; i++) {
        const chunk = text.slice(bounds[i], bounds[i + 1]).trim();
        if (chunk) chunks.push(chunk);
   }
   return chunks.length ? chunks : [text];
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function reflow(rawCues, settings) {
   const {
        maxCharsPerLine, maxLines, targetCps, minDurationMs, maxDurationMs, minGapMs,
        gapDeadZoneMs = minGapMs, outTimeBufferMs = 0, stripDisfluencies: shouldStrip,
        language = "en",
   } = settings;
   const lang = SUPPORTED_LANGUAGES.includes(language) ? language : "en";
   const warnings = [];

   const allCaps = looksAllCaps(rawCues);
   if (allCaps) {
        warnings.push(
               "Source looked like an ALL CAPS transcript, so it was converted to sentence case automatically - please spot-check proper nouns and acronyms."
             );
   }
   const { confident: speakersConfident } = detectSpeakerLabels(rawCues);
   let cues = rawCues
     .map((c) => {
            let text = c.text;
            let speaker = null;
            if (speakersConfident) {
                     const m = SPEAKER_LABEL_RE.exec(text);
                     if (m) {
                                speaker = normalizeSpeakerLabel(m[1]);
                                text = text.slice(m[0].length);
                     }
            }
            text = shouldStrip ? stripDisfluencies(text, lang) : text;
            text = text.replace(/\s+/g, " ").trim();
            text = normalizeEllipsis(text);
            if (allCaps) text = toSentenceCase(text, lang);
            const { text: extracted, italic } = extractItalicsMarker(text, lang);
            return { startMs: c.startMs, endMs: c.endMs, text: extracted, italic, speaker };
     })
     .filter((c) => c.text.length > 0 && c.endMs > c.startMs);

   const merged = [];
   for (const cue of cues) {
        const prev = merged[merged.length - 1];
        if (prev) {
               const gap = cue.startMs - prev.endMs;
               const combinedText = `${prev.text} ${cue.text}`.trim();
               const combinedDuration = cue.endMs - prev.startMs;
               const fitsLines = wrapLines(combinedText, maxCharsPerLine).length <= maxLines;
               const sameSpeaker = (prev.speaker || null) === (cue.speaker || null);
               if (gap <= 300 && fitsLines && combinedDuration <= maxDurationMs && prev.italic === cue.italic && sameSpeaker) {
                        prev.text = combinedText;
                        prev.endMs = cue.endMs;
                        continue;
               }
        }
        merged.push({ ...cue });
   }
   cues = merged;

   if (speakersConfident) {
        const dashed = [];
        for (const cue of cues) {
               const prev = dashed[dashed.length - 1];
               if (
                        prev && !prev.dualSpeaker && prev.speaker && cue.speaker &&
                        prev.speaker !== cue.speaker && !prev.italic && !cue.italic &&
                        prev.text.length <= maxCharsPerLine && cue.text.length <= maxCharsPerLine &&
                        cue.startMs - prev.endMs <= 1000 && maxLines >= 2
                      ) {
                        dashed[dashed.length - 1] = {
                                   startMs: prev.startMs,
                                   endMs: cue.endMs,
                                   text: `- ${prev.text}\n- ${cue.text}`,
                                   italic: false,
                                   dualSpeaker: true,
                        };
                        continue;
               }
               dashed.push({ ...cue });
        }
        cues = dashed;
   }

   const split = [];
   for (const cue of cues) {
        if (cue.dualSpeaker) {
               split.push({ ...cue });
               continue;
        }
        const duration = cue.endMs - cue.startMs;
        const lineCount = wrapLines(cue.text, maxCharsPerLine).length;
        const cps = cue.text.length / Math.max(duration / 1000, 0.001);

        const splitsForLines = Math.ceil(lineCount / maxLines);
        const splitsForMaxDuration = Math.ceil(duration / maxDurationMs);
        const splitsForCps = splitsForLines > 1 ? Math.ceil(cps / targetCps) : 1;
        const n = Math.max(1, splitsForLines, splitsForMaxDuration, splitsForCps);

        if (n === 1) {
               split.push({ ...cue });
               continue;
        }

        const chunks = splitIntoChunks(cue.text, n, lang);
        const totalChars = chunks.reduce((s, c) => s + c.length, 0) || 1;
        let cursor = cue.startMs;
        chunks.forEach((chunkText, i) => {
               const isLast = i === chunks.length - 1;
               const share = chunkText.length / totalChars;
               const chunkDuration = isLast ? cue.endMs - cursor : Math.max(minDurationMs, Math.round(duration * share));
               const start = cursor;
               const end = isLast ? cue.endMs : Math.min(cue.endMs, start + chunkDuration);
               split.push({ startMs: start, endMs: Math.max(end, start + 1), text: chunkText, italic: cue.italic });
               cursor = end;
        });
   }
   cues = split;

   for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        const next = cues[i + 1];
        if (next) {
               const gap = next.startMs - cue.endMs;
               if (gap < minGapMs) {
                        cue.endMs = Math.max(cue.startMs + 1, next.startMs - minGapMs);
               } else if (gap < gapDeadZoneMs) {
                        const target = Math.min(next.startMs - minGapMs, cue.endMs + outTimeBufferMs, cue.startMs + maxDurationMs);
                        if (target > cue.endMs) cue.endMs = target;
               }
        }
        const duration = cue.endMs - cue.startMs;
        if (duration < minDurationMs) {
               const room = next ? Math.max(0, next.startMs - minGapMs - cue.endMs) : Infinity;
               const extend = Math.min(minDurationMs - duration, room);
               cue.endMs += extend;
               if (cue.endMs - cue.startMs < minDurationMs) {
                        warnings.push(
                                   `Cue at ${cue.startMs}ms is shorter than the ${minDurationMs}ms minimum and there's no room to extend it (dialogue is too dense here) - "${cue.text.slice(0, 40)}${cue.text.length > 40 ? "…" : ""}"`
                                 );
               }
        } else if (duration > maxDurationMs) {
               cue.endMs = cue.startMs + maxDurationMs;
        }
   }

   const edits = [];
   if (shouldStrip) {
        cues = cues.map((cue) => {
               if (cue.dualSpeaker) return cue;
               const duration = cue.endMs - cue.startMs;
               const cps = cue.text.length / Math.max(duration / 1000, 0.001);
               if (cps <= targetCps) return cue;
               let text = stripTrailingClause(cue.text, lang);
               text = stripFillerPhrases(text, lang);
               if (text.length >= 3 && text.length < cue.text.length) {
                        edits.push(
                                   `Cue at ${cue.startMs}ms: dropped filler wording to help it fit the reading-speed target - was "${cue.text.slice(0, 40)}${cue.text.length > 40 ? "…" : ""}", now "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}".`
                                 );
                        return { ...cue, text };
               }
               return cue;
        });
   }

   cues = cues.map((cue) => {
        const lines = cue.dualSpeaker ? cue.text.split("\n") : wrapLinesSmart(cue.text, maxCharsPerLine, lang);
        const duration = cue.endMs - cue.startMs;
        const cps = Math.round((cue.text.length / Math.max(duration / 1000, 0.001)) * 10) / 10;
        if (lines.length > maxLines) {
               warnings.push(`Cue at ${cue.startMs}ms still wraps to ${lines.length} lines (max ${maxLines}) - "${cue.text.slice(0, 40)}…"`);
        }
        if (cps > targetCps) {
               warnings.push(`Cue at ${cue.startMs}ms reads at ~${cps} chars/sec (target ${targetCps}) - dialogue is too dense for its duration - "${cue.text.slice(0, 40)}…"`);
        }
        const outputLines = cue.italic ? lines.map((l) => `<i>${l}</i>`) : lines;
        return { startMs: cue.startMs, endMs: cue.endMs, text: outputLines.join("\n"), lineCount: lines.length, cps };
   });

   return { cues, warnings, edits };
}

function cleanSrt(rawSrtText, userSettings = {}) {
   const srt = require("./srt");
   const settings = resolveSettings(userSettings);
   const rawCues = srt.parseSrt(rawSrtText);
   const { cues, warnings, edits } = reflow(rawCues, settings);
   const outputSrt = srt.stringifySrt(cues);
   return {
        settings,
        cues,
        warnings,
        edits,
        outputSrt,
        stats: {
               inputCueCount: rawCues.length,
               outputCueCount: cues.length,
        },
   };
}

module.exports = {
   PRESETS,
   DEFAULT_SETTINGS,
   LANGUAGES,
   SUPPORTED_LANGUAGES,
   resolveSettings,
   stripDisfluencies,
   stripFillerPhrases,
   stripTrailingClause,
   normalizeEllipsis,
   toSentenceCase,
   looksAllCaps,
   extractItalicsMarker,
   detectSpeakerLabels,
   wrapLines,
   wrapLinesSmart,
   reflow,
   cleanSrt,
   findBreakPoints,
   splitIntoChunks,
};

