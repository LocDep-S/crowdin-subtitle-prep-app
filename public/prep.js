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
  maxCharsPerLine: document.getElementById("maxCharsPerLine"),
  maxLines: document.getElementById("maxLines"),
  targetCps: document.getElementById("targetCps"),
  minDurationMs: document.getElementById("minDurationMs"),
  maxDurationMs: document.getElementById("maxDurationMs"),
  minGapMs: document.getElementById("minGapMs"),
  cleanBtn: document.getElementById("clean-btn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  warningsBox: document.getElementById("warnings-box"),
  warningsCount: document.getElementById("warnings-count"),
  warningsList: document.getElementById("warnings-list"),
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

const THRESHOLD_FIELDS = ["maxCharsPerLine", "maxLines", "targetCps", "minDurationMs", "maxDurationMs", "minGapMs"];

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
  const settings = { preset: preset === "custom" ? undefined : preset, stripDisfluencies: els.stripDisfluencies.checked };
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

async function loadPresets() {
  const { presets, defaults } = await fetch("/api/presets").then((r) => r.json());
  state.presets = presets;
  fillThresholdsFromPreset(defaults.preset || "netflix");
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

function renderCuePreview(cues) {
  els.cuePreview.innerHTML = "";
  for (const cue of cues) {
    const li = document.createElement("li");
    li.className = "cue";
    const dense = cue.cps > (state.cleanResult.settings.targetCps || 17);
    const overLines = cue.lineCount > (state.cleanResult.settings.maxLines || 2);
    li.innerHTML = `
      <div class="times">${msToTime(cue.startMs)} &rarr; ${msToTime(cue.endMs)} <span class="dur">(${((cue.endMs - cue.startMs) / 1000).toFixed(2)}s)</span></div>
      <div class="text">${renderCueText(cue.text)}</div>
      <div class="meta ${dense ? "warn" : ""} ${overLines ? "warn" : ""}">${cue.lineCount} line${cue.lineCount === 1 ? "" : "s"} &middot; ${cue.cps} chars/sec</div>
    `;
    els.cuePreview.appendChild(li);
  }
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
    if (result.warnings.length) {
      els.warningsBox.classList.remove("hidden");
      els.warningsCount.textContent = result.warnings.length;
      els.warningsList.innerHTML = result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
    } else {
      els.warningsBox.classList.add("hidden");
    }
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
  const blob = new Blob([state.cleanResult.outputSrt], { type: "text/plain" });
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
      body: { projectId, fileName, srtContent: state.cleanResult.outputSrt },
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
