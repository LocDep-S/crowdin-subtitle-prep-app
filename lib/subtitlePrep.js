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
 */

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
// Numbers below are the commonly-cited baseline values from each guide's own
// public documentation. BBC's own guide is expressed in words-per-minute
// rather than characters/second - targetCps here is a rough conversion
// (160-180 wpm at ~5.5 chars/word+space) so both presets can share one engine.
const PRESETS = {
  netflix: {
    label: "Netflix Timed Text Style Guide",
    maxCharsPerLine: 42,
    maxLines: 2,
    targetCps: 17,
    minDurationMs: 833, // 5/6 second
    maxDurationMs: 7000,
    minGapMs: 83, // ~2 frames at 24fps
  },
  bbc: {
    label: "BBC Subtitle Guidelines",
    maxCharsPerLine: 37,
    maxLines: 2,
    targetCps: 15, // approx. equivalent of ~170 wpm
    minDurationMs: 1000,
    maxDurationMs: 7000,
    minGapMs: 80,
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
  // Collapses an immediately-repeated word OR short phrase (up to 3 words)
  // into a single occurrence, e.g. "I I I want" -> "I want", "what I what I
  // was thinking" -> "what I was thinking". Deliberately limited to *exact,
  // immediate* repeats (checked on normalized/lowercased/punctuation-
  // stripped tokens, but the surviving occurrence keeps its original
  // casing/punctuation) - it will not touch "very very tired" (repetition
  // used for emphasis) since nothing repeats a *second* time there, and it
  // will not try to detect a cut-off false start like "I wan- I want" since
  // that needs judgment calls a token match can't safely make.
  const tokens = text.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    let collapsedHere = false;
    for (let w = Math.min(3, Math.floor((tokens.length - i) / 2)); w >= 1; w--) {
      const a = tokens.slice(i, i + w).map(normalizeToken).join(" ");
      const b = tokens.slice(i + w, i + 2 * w).map(normalizeToken).join(" ");
      if (a && a === b) {
        tokens.splice(i + w, w); // drop the duplicate occurrence, keep the first
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
  // Clean up whitespace/punctuation left behind by removals.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[,\s]+/, "")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
  return out;
}

// ---------------------------------------------------------------------------
// Line wrapping (within one cue)
// ---------------------------------------------------------------------------

/** Greedy word-wrap into lines of at most maxCharsPerLine, breaking on spaces. */
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

// ---------------------------------------------------------------------------
// Splitting overly long/dense text into N chunks at natural boundaries
// ---------------------------------------------------------------------------

/**
 * Break points ranked by strength: sentence end (0), comma/semicolon/colon
 * (1), any word boundary (2, always present as a fallback so a chunk cut
 * never has to land mid-word even when punctuation is sparse or unevenly
 * distributed through the text - see splitIntoChunks).
 */
function findBreakPoints(text) {
  const byIndex = new Map(); // index -> best (lowest) priority seen there
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
  return [...byIndex.entries()].map(([index, priority]) => ({ index, priority })).sort((a, b) => a.index - b.index);
}

/**
 * Split `text` into exactly `n` roughly-equal chunks. Cut points are chosen
 * independently against absolute targets (i * text.length / n) rather than
 * drifting forward from the previous cut, so a stretch of text with no
 * punctuation for a while doesn't throw off every chunk after it. At each
 * target, prefer the closest available break point, but only let a weaker
 * boundary type (e.g. a bare word gap) win over a nearby stronger one
 * (sentence/comma) if it's meaningfully closer - otherwise a punctuation
 * mark a few characters further out is still the better place to cut.
 */
function splitIntoChunks(text, n) {
  if (n <= 1) return [text];
  const points = findBreakPoints(text);
  const cuts = [];
  let start = 0;
  for (let i = 1; i < n; i++) {
    const target = Math.round((i * text.length) / n);
    const candidates = points.filter((p) => p.index > start && p.index < text.length);
    if (!candidates.length) break;
    let best = candidates[0];
    let bestScore = Math.abs(best.index - target) + best.priority * 6;
    for (const c of candidates) {
      const score = Math.abs(c.index - target) + c.priority * 6;
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

/**
 * @param {Array<{startMs:number,endMs:number,text:string}>} rawCues
 * @param {object} settings resolved via resolveSettings()
 * @returns {{ cues: Array, warnings: Array<string> }}
 */
function reflow(rawCues, settings) {
  const { maxCharsPerLine, maxLines, targetCps, minDurationMs, maxDurationMs, minGapMs, stripDisfluencies: shouldStrip } = settings;
  const warnings = [];

  // 1. Clean text, drop empties.
  let cues = rawCues
    .map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      text: (shouldStrip ? stripDisfluencies(c.text) : c.text).replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text.length > 0 && c.endMs > c.startMs);

  // 2. Merge pass: fold very short/fragmented adjacent cues together when
  // the gap between them is small (continuous speech) and the combined
  // result would still fit the format - undoes over-fragmented ASR output
  // before the split pass below handles the opposite problem.
  const merged = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const gap = cue.startMs - prev.endMs;
      const combinedText = `${prev.text} ${cue.text}`.trim();
      const combinedDuration = cue.endMs - prev.startMs;
      const fitsLines = wrapLines(combinedText, maxCharsPerLine).length <= maxLines;
      if (gap <= 300 && fitsLines && combinedDuration <= maxDurationMs) {
        prev.text = combinedText;
        prev.endMs = cue.endMs;
        continue;
      }
    }
    merged.push({ ...cue });
  }
  cues = merged;

  // 3. Split pass: for each cue, decide how many pieces it needs based on
  // both line-count and reading-speed limits, then divide text and time
  // proportionally by character count (no per-word timestamps available).
  const split = [];
  for (const cue of cues) {
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
      split.push({ startMs: start, endMs: Math.max(end, start + 1), text: chunkText });
      cursor = end;
    });
  }
  cues = split;

  // 4. Enforce min gap between consecutive cues (shrink the earlier cue's
  // end time), then min/max duration, flagging anything that couldn't be
  // resolved without violating a neighboring constraint.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (next) {
      const gap = next.startMs - cue.endMs;
      if (gap < minGapMs) {
        cue.endMs = Math.max(cue.startMs + 1, next.startMs - minGapMs);
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

  // 5. Final per-cue metadata for the UI preview (line wrap, per-line char
  // counts, cps) - wrapping is applied here for display; the stored `text`
  // keeps single spaces and the UI/exporter re-wraps consistently.
  cues = cues.map((cue) => {
    const lines = wrapLines(cue.text, maxCharsPerLine);
    const duration = cue.endMs - cue.startMs;
    const cps = Math.round((cue.text.length / Math.max(duration / 1000, 0.001)) * 10) / 10;
    if (lines.length > maxLines) {
      warnings.push(`Cue at ${cue.startMs}ms still wraps to ${lines.length} lines (max ${maxLines}) - "${cue.text.slice(0, 40)}…"`);
    }
    if (cps > targetCps) {
      warnings.push(`Cue at ${cue.startMs}ms reads at ~${cps} chars/sec (target ${targetCps}) - dialogue is too dense for its duration - "${cue.text.slice(0, 40)}…"`);
    }
    return { startMs: cue.startMs, endMs: cue.endMs, text: lines.join("\n"), lineCount: lines.length, cps };
  });

  return { cues, warnings };
}

/**
 * @param {string} rawSrtText
 * @param {object} userSettings partial settings, see resolveSettings()
 */
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
  wrapLines,
  reflow,
  cleanSrt,
  findBreakPoints,
  splitIntoChunks,
};
