/**
 * SRT parse/serialize helpers. Copied verbatim from the sibling
 * crowdin-subtitle-timing-app repo (lib/srt.js) - this is generic SRT
 * plumbing with no dependency on that app's Crowdin-specific storage model,
 * so it's duplicated here rather than shared, to keep this app's repo (and
 * deploy) fully independent per the "separate app" decision.
 */

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
const CUE_HEADER_RE = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;

function timeToMs(t) {
  const m = TIME_RE.exec(t);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return (
    parseInt(hh, 10) * 3600000 +
    parseInt(mm, 10) * 60000 +
    parseInt(ss, 10) * 1000 +
    parseInt(ms, 10)
  );
}

function msToTime(totalMs) {
  totalMs = Math.max(0, Math.round(totalMs));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

/** Parse raw SRT text into an ordered array of cues: { index, startMs, endMs, text }. */
function parseSrt(raw) {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/﻿/g, "");
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines.length) continue;

    let cursor = 0;
    let index = cues.length + 1;
    if (/^\d+$/.test(lines[cursor].trim())) {
      index = parseInt(lines[cursor].trim(), 10);
      cursor += 1;
    }
    if (cursor >= lines.length) continue;

    const headerMatch = CUE_HEADER_RE.exec(lines[cursor].trim());
    if (!headerMatch) continue;
    cursor += 1;

    const text = lines.slice(cursor).join("\n").trim();

    cues.push({
      index,
      startMs: timeToMs(headerMatch[1]),
      endMs: timeToMs(headerMatch[2]),
      text,
    });
  }
  return cues;
}

/** Serialize a cue array into a valid .srt file. */
function stringifySrt(cues) {
  return cues
    .map((cue, i) => {
      const n = i + 1;
      return `${n}\n${msToTime(cue.startMs)} --> ${msToTime(cue.endMs)}\n${cue.text}\n`;
    })
    .join("\n");
}

module.exports = { parseSrt, stringifySrt, timeToMs, msToTime };
