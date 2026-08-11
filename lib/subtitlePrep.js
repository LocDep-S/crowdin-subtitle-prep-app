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
 * Beyond the core numeric limits (line length/count, reading speed, min/max
 * duration, min gap), this also applies a second layer of style-guide rules
 * that don't reduce to a single number:
 *  - Grammar-aware line breaks: when a 2-line cue's break point has more
 *    than one option that fits, prefer breaking after punctuation, avoid
 *    stranding an article/preposition/conjunction at the end of line 1
 *    (Netflix: "breaks should fall after punctuation or before conjunctions
 *    /prepositions"), avoid splitting what looks like a two-part proper
  *    name, and prefer a bottom-heavy or balanced shape over a top-heavy one.
   *    The same weak-word avoidance also applies one level up, when a dense
    *    cue has to be split into several separate cues rather than just lines.
 *  - Formatting conventions: three-dot ellipses are normalized to a single
 *    "…" character; a transcript that arrives in ALL CAPS is converted to
 *    sentence case; transcript-side voice-over/narration markers
 *    ("(V.O.)", "(voiceover)") and song markers ("♪ ... ♪") are converted
 *    into <i>italic</i> lines and the marker text is stripped.
 *  - The "half-second rule" for gaps: a gap that's already under the
 *    minimum gets closed to the minimum; a gap that's short but not quite
 *    a comfortable pause (the awkward zone between the 2-frame minimum and
 *    about half a second) gets closed the same way rather than left
 *    dangling, which doubles as a modest reading-comfort buffer on the
 *    preceding cue's out-time.
 *
 * What this engine still can't do, because the input is a transcript, not a
 * video: it has no shot/scene-cut information, so it can't snap cue
 * boundaries to shot changes the way Netflix's guide asks for. It also
 * can't reliably identify foreign-language terms or proper-noun casing
 * without real NLP, so those two style points aren't automated.
 */

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
// Numbers below are the commonly-cited baseline values from each guide's own
// public documentation. BBC's own guide is expressed in words-per-minute
// rather than characters/second - targetCps here is a rough conversion
// (160-180 wpm at ~5.5 chars/word+space) so both presets can share one engine.
// `gapDeadZoneMs`/`outTimeBufferMs` implement Netflix's documented
// half-second rule (see reflow() step 4); BBC's guide doesn't specify an
// equivalent, so those are left at values that effectively disable it there
// rather than inventing a number Netflix never published.
const PRESETS = {
    netflix: {
          label: "Netflix Timed Text Style Guide",
          maxCharsPerLine: 42,
          maxLines: 2,
          targetCps: 20, // adult programs (Netflix children's programs limit is 17 cps)
          minDurationMs: 833, // 5/6 second
          maxDurationMs: 7000,
          minGapMs: 83, // ~2 frames at 24fps
          gapDeadZoneMs: 500, // "half-second rule" - gaps shorter than this get closed to minGapMs
          outTimeBufferMs: 500, // reading-comfort hold past the last spoken word, when there's room
    },
    bbc: {
          label: "BBC Subtitle Guidelines",
          maxCharsPerLine: 37,
          maxLines: 2,
          targetCps: 15, // approx. equivalent of ~170 wpm
          minDurationMs: 1000,
          maxDurationMs: 7000,
          minGapMs: 80,
          gapDeadZoneMs: 80, // no published half-second rule for BBC - disabled (equal to minGapMs)
          outTimeBufferMs: 0,
    },
};

const DEFAULT_SETTINGS = {
    preset: "netflix",
    ...PRESETS.netflix,
    stripDisfluencies: true,
};

/** Merge a preset (by name) with any explicit per-field overrides. */
function resolveSettings(userSettings = {}) {
    const base = PRESETS[userSettings.preset] || PRESETS.netflix;
    return {
          ...DEFAULT_SETTINGS,
          ...base,
          ...userSettings,
    };
}

// ---------------------------------------------------------------------------
// Disfluency stripping
// ---------------------------------------------------------------------------
// Deliberately conservative: only tokens that are almost never meaningful
// content on their own (um, uh, erm, hmm...) and immediate word-repetition
// stutters ("I I I want" -> "I want"). Filler words that frequently carry
// real meaning or register in context - "like", "you know", "so", "well" -
// are intentionally NOT touched; stripping those has a much higher false-
// positive rate and was explicitly scoped out.
const FILLER_RE = /\b(um+|uh+|erm+|hmm+|mhm+|uh-huh|uh-uh)\b[,.]?/gi;

function normalizeToken(tok) {
    return tok.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, "");
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

function stripDisfluencies(text) {
    let out = text.replace(FILLER_RE, "");
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
// Formatting conventions (ellipses, ALL-CAPS sources, italics markers)
// ---------------------------------------------------------------------------

function normalizeEllipsis(text) {
    return text.replace(/\.(?:\s?\.){2,}/g, "…");
}

const ACRONYM_WHITELIST = [
    "OK", "TV", "FBI", "CIA", "US", "UK", "EU", "UN", "CEO", "CFO", "AI", "DNA",
    "NASA", "ID", "PHD", "ATM", "GPS", "VIP", "DJ", "MC", "FYI", "ASAP", "DIY",
  ];

function looksAllCaps(cues) {
    let upper = 0;
    let letters = 0;
    for (const c of cues) {
          for (const ch of c.text) {
                  if (/[a-zA-Z]/.test(ch)) {
                            letters += 1;
                            if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) upper += 1;
                  }
          }
    }
    return letters > 20 && upper / letters > 0.85;
}

function toSentenceCase(text) {
    let out = text.toLowerCase();
    out = out.replace(/(^\s*|[.!?]\s+)([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase());
    out = out.replace(/\bi\b/g, "I").replace(/\bi'(m|ll|ve|d)\b/g, (m) => "I'" + m.slice(2));
    for (const acr of ACRONYM_WHITELIST) {
          out = out.replace(new RegExp(`\\b${acr.toLowerCase()}\\b`, "g"), acr);
    }
    return out;
}

const VO_MARKER_RE = /^\s*[([]\s*(?:v\.?\s?o\.?|voice[\s-]?over|narrat(?:ion|ing))\s*[)\]]\s*[:\-]?\s*/i;
const SONG_MARK_RE = /[♪♫]/;

function extractItalicsMarker(text) {
    const voMatch = VO_MARKER_RE.exec(text);
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
// capitalized words followed by a colon, a space, and more text.
const SPEAKER_LABEL_RE = /^\s*([A-Z][A-Za-z.'-]{0,20}(?:\s[A-Z][A-Za-z.'-]{0,20}){0,2}):\s+(?=\S)/;

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

const WEAK_END_WORDS = new Set([
    "a", "an", "the",
    "in", "on", "at", "to", "of", "for", "with", "by", "from", "as", "into",
    "onto", "upon", "about", "over", "under", "between", "through", "during",
    "before", "after", "above", "below", "without", "within", "near", "since",
    "until", "unless", "though", "although", "against", "among", "across",
    "behind", "beside", "beyond", "along", "around", "toward", "towards", "per",
    "and", "but", "or", "nor", "so", "yet", "because", "if", "when", "while",
    "whereas", "than", "that",
    "my", "your", "his", "her", "its", "our", "their", "this", "these", "those",
  ]);

function endsWeak(word) {
    const clean = word.toLowerCase().replace(/[^\w']/g, "");
    return WEAK_END_WORDS.has(clean);
}

function looksLikeNamePair(wordA, wordB) {
    const isCap = (w) => /^[A-Z][a-z]/.test(w);
    return isCap(wordA) && isCap(wordB) && !/[.!?,;:]$/.test(wordA);
}

function scoreSplit(words, splitIdx, maxCharsPerLine) {
    const line1 = words.slice(0, splitIdx).join(" ");
    const line2 = words.slice(splitIdx).join(" ");
    if (line1.length > maxCharsPerLine || line2.length > maxCharsPerLine) return Infinity;

  let score = 0;
    const diff = line1.length - line2.length;
    score += Math.max(0, diff) * 1.2;
    score += Math.abs(diff) * 0.15;

  const lastWordL1 = words[splitIdx - 1];
    if (endsWeak(lastWordL1)) score += 40;
    if (looksLikeNamePair(words[splitIdx - 1], words[splitIdx])) score += 60;
    if (/[.!?]$/.test(lastWordL1)) score -= 20;
    else if (/[,;:]$/.test(lastWordL1)) score -= 10;

  return score;
}

function wrapLinesSmart(text, maxCharsPerLine) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const greedy = wrapLines(text, maxCharsPerLine);
    if (greedy.length !== 2) return greedy;

  let best = null;
    let bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
          const s = scoreSplit(words, i, maxCharsPerLine);
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
// `idx` points *after* the delimiter (space, or comma/period + the space that
// follows it), so strip any trailing run of non-word chars first or the word
// itself would never match at the end of the string.
function wordBeforeIndex(text, idx) {
      const before = text.slice(0, idx).replace(/[^A-Za-z']+$/, "");
      const m = /[A-Za-z']+$/.exec(before);
      return m ? m[0] : "";
}

// The word immediately at/after `idx` in `text` (no leading punctuation/whitespace).
function wordAfterIndex(text, idx) {
 const m = /^[A-Za-z']+/.exec(text.slice(idx));
 return m ? m[0] : "";
}

// Break points ranked by strength: sentence end (0), comma/semicolon/colon
// (1), any word boundary (2, always a fallback). Each point also records
// whether the word right before it is a weak word (article/preposition/
// conjunction, via the same endsWeak() used for in-cue line breaks) so a
// cue-to-cue split doesn't end on "...for the" any more than an in-cue line
// break would.
function findBreakPoints(text) {
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
        .map(([index, priority]) => ({ index, priority, weakEnd: endsWeak(wordBeforeIndex(text, index)), namePair: looksLikeNamePair(wordBeforeIndex(text, index), wordAfterIndex(text, index)) }))
        .sort((a, b) => a.index - b.index);
}

// Split `text` into exactly `n` roughly-equal chunks, cutting at the break
// point closest to each absolute target (i * text.length / n), weighted by
// boundary strength and penalized for ending a chunk right after a weak
// word - same idea as scoreSplit() for in-cue line breaks.
function splitIntoChunks(text, n) {
      if (n <= 1) return [text];
      const points = findBreakPoints(text);
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
    } = settings;
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
        text = shouldStrip ? stripDisfluencies(text) : text;
       text = text.replace(/\s+/g, " ").trim();
       text = normalizeEllipsis(text);
       if (allCaps) text = toSentenceCase(text);
        const { text: extracted, italic } = extractItalicsMarker(text);
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
          const splitsForCps = Math.ceil(cps / targetCps);
          const splitsForMaxDuration = Math.ceil(duration / maxDurationMs);
          const n = Math.max(1, splitsForLines, splitsForCps, splitsForMaxDuration);

      if (n === 1) {
              split.push({ ...cue });
              continue;
      }

      const chunks = splitIntoChunks(cue.text, n);
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

  cues = cues.map((cue) => {
        const lines = cue.dualSpeaker ? cue.text.split("\n") : wrapLinesSmart(cue.text, maxCharsPerLine);
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

  return { cues, warnings };
}

function cleanSrt(rawSrtText, userSettings = {}) {
    const srt = require("./srt");
    const settings = resolveSettings(userSettings);
    const rawCues = srt.parseSrt(rawSrtText);
    const { cues, warnings } = reflow(rawCues, settings);
    const outputSrt = srt.stringifySrt(cues);
    return {
          settings,
          cues,
          warnings,
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
    resolveSettings,
    stripDisfluencies,
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
