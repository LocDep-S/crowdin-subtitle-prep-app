/**
 * Subtitle Prep - standalone org-level tool. No project/file context (this
 * is an "organization-menu" module, not tied to any file) - the only thing
 * we get from Crowdin's iframe SDK here is a fresh jwtToken per request,
 * used purely to authenticate our own server calls (see server.js's
 * requireJwt). Project selection happens entirely client-side, from the
 * project list the user picks from in the upload modal.
 */

const els = {
  dropLabel: document.getElementById("drop-label"),
  dropText: document.getElementById("drop-text"),
  fileInput: document.getElementById("file-input"),
  fileName: document.getElementById("file-name"),
  settingsPanel: document.getElementById("settings-panel"),
  presetSelect: document.getElementById("preset-select"),
  stripDisfluencies: document.getElementById("strip-disfluencies"),
  sourceLanguage: document.getElementById("source-language"),
  maxCharsPerLine: document.getElementById("maxCharsPerLine"),
  maxLines: document.getElementById("maxLines"),
  targetCps: document.getElementById("targetCps"),
  minDurationMs: document.getElementById("minDurationMs"),
  maxDurationMs: document.getElementById("maxDurationMs"),
  minGapMs: document.getElementById("minGapMs"),
  gapDeadZoneMs: document.getElementById("gapDeadZoneMs"),
  outTimeBufferMs: document.getElementById("outTimeBufferMs"),
  cleanBtn: document.getElementById("clean-btn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  warningsBox: document.getElementById("warnings-box"),
  warningsCount: document.getElementById("warnings-count"),
  warningsList: document.getElementById("warnings-list"),
  editsBox: document.getElementById("edits-box"),
  editsCount: document.getElementById("edits-count"),
  editsList: document.getElementById("edits-list"),
  statsBox: document.getElementById("stats-box"),
  cuePreview: document.getElementById("cue-preview"),
  downloadBtn: document.getElementById("download-btn"),
  uploadBtn: document.getElementById("upload-btn"),
  uploadModal: document.getElementById("upload-modal"),
  projectSelect: document.getElementById("project-select"),
  uploadFilename: document.getElementById("upload-filename"),
  uploadConfirmBtn: document.getElementById("upload-confirm-btn"),
  uploadCancelBtn: document.getElementById("upload-cancel-btn"),
  uploadStatus: document.getElementById("upload-status"),
};

const state = {
  rawSrt: null,
  sourceFileName: "subtitles.srt",
  presets: {},
  cleanResult: null,
  projects: null,
};

const THRESHOLD_FIELDS = ["maxCharsPerLine", "maxLines", "targetCps", "minDurationMs", "maxDurationMs", "minGapMs", "gapDeadZoneMs", "outTimeBufferMs"];

function getJwtToken() {
  return new Promise((resolve) => {
    if (window.AP && typeof AP.getJwtToken === "function") {
      AP.getJwtToken((token) => resolve(token));
    } else {
      // local dev fallback
      const params = new URLSearchParams(window.location.search);
      resolve(params.get("jwtToken") || "");
    }
  });
}

async function api(path, opts = {}) {
  const jwtToken = await getJwtToken();
  const method = opts.method || "GET";
  const url = method === "GET" ? `${path}?jwtToken=${encodeURIComponent(jwtToken)}` : path;
  const body = method === "GET" ? undefined : JSON.stringify({ ...(opts.body || {}), jwtToken });
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function currentSettings() {
  const preset = els.presetSelect.value;
  const settings = { preset: preset === "custom" ? undefined : preset, stripDisfluencies: els.stripDisfluencies.checked, language: els.sourceLanguage.value };
  for (const field of THRESHOLD_FIELDS) {
    const val = parseFloat(els[field].value);
    if (!Number.isNaN(val)) settings[field] = val;
  }
  return settings;
}

function fillThresholdsFromPreset(presetKey) {
  const preset = state.presets[presetKey];
  if (!preset) return;
  for (const field of THRESHOLD_FIELDS) {
    if (els[field] && preset[field] !== undefined) els[field].value = preset[field];
  }
}

// Populated from the server's LANGUAGES table (lib/subtitlePrep.js) rather
// than hardcoded here, so adding a new language later is a server-side-only
// change - no HTML edit needed.
function fillLanguageOptions(languages, selected) {
  if (!languages) return;
  els.sourceLanguage.innerHTML = Object.entries(languages)
    .map(([code, label]) => `<option value="${code}">${escapeHtml(label)}</option>`).join("");
  if (selected && languages[selected]) els.sourceLanguage.value = selected;
}

async function loadPresets() {
  const { presets, defaults, languages } = await fetch("/api/presets").then((r) => r.json());
  state.presets = presets;
  fillThresholdsFromPreset(defaults.preset || "netflix");
  fillLanguageOptions(languages, defaults.language || "en");
}

function handleFile(file) {
  if (!file) return;
  state.sourceFileName = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    state.rawSrt = reader.result;
    els.fileName.textContent = `Loaded: ${file.name} (${file.size.toLocaleString()} bytes)`;
    els.fileName.classList.remove("hidden");
    els.dropText.textContent = "Drop a different .srt file, or click to choose one";
    els.settingsPanel.classList.remove("hidden");
    els.results.classList.add("hidden");
  };
  reader.readAsText(file);
}

els.fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));
els.dropLabel.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.dropLabel.classList.add("dragover");
});
els.dropLabel.addEventListener("dragleave", () => els.dropLabel.classList.remove("dragover"));
els.dropLabel.addEventListener("drop", (e) => {
  e.preventDefault();
  els.dropLabel.classList.remove("dragover");
  handleFile(e.dataTransfer.files[0]);
});

els.presetSelect.addEventListener("change", () => {
  if (els.presetSelect.value !== "custom") fillThresholdsFromPreset(els.presetSelect.value);
});
// Editing any threshold field manually switches the preset dropdown to "Custom".
for (const field of THRESHOLD_FIELDS) {
  els[field].addEventListener("input", () => {
    els.presetSelect.value = "custom";
  });
}

// Cue text/timing is editable in place; these helpers keep the derived
// numbers (line count, cps, overlap) and the SRT the download/upload
// buttons use in sync with whatever the user has typed, rather than
// re-running the server-side engine on every keystroke.
function computeCueMeta(cue) {
  const duration = cue.endMs - cue.startMs;
  const lineCount = cue.text.split("\n").filter((l) => l.length > 0).length || 1;
  const plain = cue.text.split("<i>").join("").split("</i>").join("");
  const cps = Math.round((plain.length / Math.max(duration / 1000, 0.001)) * 10) / 10;
  return { lineCount, cps };
}

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
function timeToMs(text) {
  const m = TIME_RE.exec((text || "").trim());
  if (!m) return null;
  const [, hh, mm, ss, ms] = m;
  return (
    parseInt(hh, 10) * 3600000 +
    parseInt(mm, 10) * 60000 +
    parseInt(ss, 10) * 1000 +
    parseInt(ms.padEnd(3, "0").slice(0, 3), 10)
    );
}

function serializeSrt(cues) { return cues.map((cue, i) => `${i + 1}\n${msToTime(cue.startMs)} --> ${msToTime(cue.endMs)}\n${cue.text}\n`).join("\n"); }

function renderCuePreview(cues) {
  const settings = state.cleanResult.settings;
  els.cuePreview.innerHTML = cues.map((cue, i) => {
    const meta = computeCueMeta(cue);
    cue.lineCount = meta.lineCount;
    cue.cps = meta.cps;
    const dense = meta.cps > (settings.targetCps || 20);
    const overLines = meta.lineCount > (settings.maxLines || 2);
    const next = cues[i + 1];
    const overlaps = !!(next && cue.endMs > next.startMs);
    const rowClass = "cue" + (overlaps ? " overlap" : "");
    const overlapFlag = overlaps ? '<span class="overlap-flag">overlaps next cue</span>' : "";
    const warnClass = (dense || overLines) ? "warn" : "";
    return '<li class="' + rowClass + '" data-index="' + i + '">' +
      '<div class="times">' +
      '<input type="text" class="time-input" data-role="start" value="' + msToTime(cue.startMs) + '" />' +
      '<span>&rarr;</span>' +
      '<input type="text" class="time-input" data-role="end" value="' + msToTime(cue.endMs) + '" />' +
      '<span class="dur">(' + ((cue.endMs - cue.startMs) / 1000).toFixed(2) + 's)</span>' +
      overlapFlag +
      '</div>' +
      '<textarea class="cue-text" rows="' + Math.max(2, cue.text.split("\n").length) + '">' + escapeHtml(cue.text) + '</textarea>' +
      '<div class="meta ' + warnClass + '">' + meta.lineCount + ' line' + (meta.lineCount === 1 ? "" : "s") + ' &middot; ' + meta.cps + ' chars/sec</div>' +
      '<div class="cue-actions">' +
      '<button type="button" data-action="clone">Clone</button>' +
      '<button type="button" data-action="delete">Delete</button>' +
      '</div>' +
      '</li>';
  }).join("");
}

// Shown once, right after /api/clean - a record of the automatic filler /
// trailing-hedge trims the engine made on cues that were still too dense
// after splitting and duration extension. Not re-run on later manual edits
// (state.cleanResult.edits stays a historical record, not a live list).
function renderEditsBox(edits) {
    if (edits && edits.length) {
          els.editsBox.classList.remove("hidden");
          els.editsCount.textContent = edits.length;
          els.editsList.innerHTML = edits.map((e) => "<li>" + escapeHtml(e) + "</li>").join("");
    } else {
          els.editsBox.classList.add("hidden");
    }
}

function renderWarningsBox() {
  const warnings = state.cleanResult.warnings;
  if (warnings.length) {
    els.warningsBox.classList.remove("hidden");
    els.warningsCount.textContent = warnings.length;
    els.warningsList.innerHTML = warnings.map((w) => "<li>" + escapeHtml(w) + "</li>").join("");
  } else {
    els.warningsBox.classList.add("hidden");
  }
}

// Re-checks every cue against the current thresholds after an edit, so the
// warnings list reflects what's actually on screen rather than the one-time
// result of the initial /api/clean call.
function recomputeWarnings() {
  const settings = state.cleanResult.settings;
  const cues = state.cleanResult.cues;
  const warnings = [];
  cues.forEach((cue, i) => {
    const meta = computeCueMeta(cue);
    cue.lineCount = meta.lineCount;
    cue.cps = meta.cps;
    const preview = cue.text.split("\n").join(" ").slice(0, 40);
    if (meta.lineCount > settings.maxLines) {
      warnings.push("Cue at " + cue.startMs + "ms wraps to " + meta.lineCount + " lines (max " + settings.maxLines + ') - "' + preview + '…"');
    }
    if (meta.cps > settings.targetCps) {
      warnings.push("Cue at " + cue.startMs + "ms reads at ~" + meta.cps + " chars/sec (target " + settings.targetCps + ') - "' + preview + '…"');
    }
    const next = cues[i + 1];
    if (next && cue.endMs > next.startMs) {
      warnings.push("Cue at " + cue.startMs + "ms overlaps the next cue (ends at " + cue.endMs + "ms, next starts at " + next.startMs + "ms) - fix the timing before exporting.");
    }
  });
  state.cleanResult.warnings = warnings;
  els.statsBox.textContent = state.cleanResult.stats.inputCueCount + " cue" + (state.cleanResult.stats.inputCueCount === 1 ? "" : "s") + " in the original file → " + cues.length + " cue" + (cues.length === 1 ? "" : "s") + " after cleanup (edited).";
  renderWarningsBox();
}

function updateCueMetaDisplay(li, cue) {
  const settings = state.cleanResult.settings;
  const meta = computeCueMeta(cue);
  cue.lineCount = meta.lineCount;
  cue.cps = meta.cps;
  const dense = meta.cps > (settings.targetCps || 20);
  const overLines = meta.lineCount > (settings.maxLines || 2);
  const metaEl = li.querySelector(".meta");
  metaEl.textContent = meta.lineCount + " line" + (meta.lineCount === 1 ? "" : "s") + " · " + meta.cps + " chars/sec";
  metaEl.classList.toggle("warn", dense || overLines);
}

// Editing is done via delegated listeners on the list container (rather than
// per-cue bindings) since cue rows get replaced wholesale on clone/delete.
els.cuePreview.addEventListener("input", (e) => {
  if (!e.target.matches(".cue-text")) return;
  const li = e.target.closest(".cue");
  const cue = state.cleanResult.cues[Number(li.dataset.index)];
  cue.text = e.target.value;
  updateCueMetaDisplay(li, cue);
  recomputeWarnings();
});

els.cuePreview.addEventListener("change", (e) => {
  if (!e.target.matches(".time-input")) return;
  const li = e.target.closest(".cue");
  const cue = state.cleanResult.cues[Number(li.dataset.index)];
  const ms = timeToMs(e.target.value);
  if (ms === null) {
    e.target.classList.add("invalid");
    return;
  }
  e.target.classList.remove("invalid");
  if (e.target.dataset.role === "start") cue.startMs = ms;
  else cue.endMs = ms;
  renderCuePreview(state.cleanResult.cues);
  recomputeWarnings();
});

els.cuePreview.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const li = btn.closest(".cue");
  const index = Number(li.dataset.index);
  if (btn.dataset.action === "clone") {
    state.cleanResult.cues.splice(index + 1, 0, { ...state.cleanResult.cues[index] });
  } else if (btn.dataset.action === "delete") {
    state.cleanResult.cues.splice(index, 1);
  }
  renderCuePreview(state.cleanResult.cues);
  recomputeWarnings();
});

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

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Escape everything, then un-escape just the <i>/</i> tags our own engine
// adds for voice-over/song lines, so the preview shows real italics instead
// of literal "<i>" text - safe since those are the only tags this app ever
// emits into cue text.
function renderCueText(text) {
    return escapeHtml(text)
      .replace(/&lt;i&gt;/g, "<i>")
      .replace(/&lt;\/i&gt;/g, "</i>")
      .replace(/\n/g, "<br/>");
}

els.cleanBtn.addEventListener("click", async () => {
  els.status.textContent = "Cleaning…";
  els.cleanBtn.disabled = true;
  try {
    const result = await api("/api/clean", { method: "POST", body: { rawSrt: state.rawSrt, settings: currentSettings() } });
    state.cleanResult = result;
    els.status.textContent = "";
    els.results.classList.remove("hidden");
    els.statsBox.textContent = `${result.stats.inputCueCount} cue${result.stats.inputCueCount === 1 ? "" : "s"} in the original file → ${result.stats.outputCueCount} cue${result.stats.outputCueCount === 1 ? "" : "s"} after cleanup.`;
    renderWarningsBox();
    renderEditsBox(result.edits);
    renderCuePreview(result.cues);
    els.uploadFilename.value = state.sourceFileName.replace(/\.srt$/i, "") + ".srt";
  } catch (err) {
    els.status.textContent = `Error: ${err.message}`;
  } finally {
    els.cleanBtn.disabled = false;
  }
});

els.downloadBtn.addEventListener("click", () => {
  if (!state.cleanResult) return;
  const blob = new Blob([serializeSrt(state.cleanResult.cues)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = state.sourceFileName.replace(/\.srt$/i, "") + "-cleaned.srt";
  a.click();
  URL.revokeObjectURL(url);
});

els.uploadBtn.addEventListener("click", async () => {
  els.uploadModal.classList.remove("hidden");
  els.uploadStatus.textContent = "";
  if (!state.projects) {
    els.projectSelect.innerHTML = `<option>Loading projects…</option>`;
    try {
      const { projects } = await api("/api/projects");
      state.projects = projects;
      els.projectSelect.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    } catch (err) {
      els.projectSelect.innerHTML = `<option>Failed to load projects</option>`;
      els.uploadStatus.textContent = `Error: ${err.message}`;
    }
  }
});

els.uploadCancelBtn.addEventListener("click", () => els.uploadModal.classList.add("hidden"));

els.uploadConfirmBtn.addEventListener("click", async () => {
  if (!state.cleanResult) return;
  const projectId = els.projectSelect.value;
  const fileName = els.uploadFilename.value.trim();
  if (!projectId || !fileName) {
    els.uploadStatus.textContent = "Choose a project and a file name.";
    return;
  }
  els.uploadConfirmBtn.disabled = true;
  els.uploadStatus.textContent = "Uploading…";
  try {
    const { file } = await api("/api/upload-to-project", {
      method: "POST",
      body: { projectId, fileName, srtContent: serializeSrt(state.cleanResult.cues) },
    });
    els.uploadStatus.textContent = `Done - "${file.name}" created (file ID ${file.id}).`;
  } catch (err) {
    els.uploadStatus.textContent = `Error: ${err.message}`;
  } finally {
    els.uploadConfirmBtn.disabled = false;
  }
});

loadPresets();
if (window.AP && typeof AP.resize === "function") AP.resize();
