require("dotenv").config();
const express = require("express");
const path = require("path");
const store = require("./lib/store");
const auth = require("./lib/crowdinAuth");
const crowdin = require("./lib/crowdinApi");
const prep = require("./lib/subtitlePrep");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "5mb" }));
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.send("crowdin-subtitle-prep-app is running"));

// -----------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------
app.get("/manifest.json", (req, res) => {
  const manifest = require("./manifest.json");
  const baseUrl = process.env.PUBLIC_BASE_URL || manifest.baseUrl;
  res.json({ ...manifest, baseUrl });
});

// -----------------------------------------------------------------------
// Install / uninstall lifecycle hooks
// -----------------------------------------------------------------------
app.post("/hooks/installed", async (req, res) => {
  const { appId, appSecret, clientId, userId, organizationId, domain, baseUrl } = req.body || {};
  if (!domain || !appSecret || !clientId) {
    return res.status(400).json({ error: "Missing required installation fields" });
  }
  await store.saveInstallation(domain, { appId, appSecret, clientId, userId, organizationId, domain, baseUrl });
  console.log(`[installed] app installed for domain=${domain}`);
  res.status(204).end();
});

app.post("/hooks/uninstall", async (req, res) => {
  const { domain } = req.body || {};
  if (domain !== undefined) await store.removeInstallation(domain);
  console.log(`[uninstall] app removed for domain=${domain}`);
  res.status(204).end();
});

// -----------------------------------------------------------------------
// Auth middleware for the UI's API calls
// -----------------------------------------------------------------------
async function requireJwt(req, res, next) {
  try {
    const jwtToken = req.query.jwtToken || req.body.jwtToken;
    if (!jwtToken) return res.status(401).json({ error: "Missing jwtToken" });
    req.crowdinContext = await auth.verifyJwt(jwtToken);
    next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    res.status(401).json({ error: "Invalid jwtToken" });
  }
}

// -----------------------------------------------------------------------
// API used by public/prep.js
// -----------------------------------------------------------------------

// GET /api/presets - static, no auth needed (just the preset table for the UI's dropdown/defaults)
app.get("/api/presets", (req, res) => {
  res.json({ presets: prep.PRESETS, defaults: prep.DEFAULT_SETTINGS });
});

// POST /api/clean { rawSrt, settings } -> { cues, warnings, outputSrt, stats }
app.post("/api/clean", requireJwt, (req, res) => {
  try {
    const { rawSrt, settings } = req.body || {};
    if (!rawSrt || typeof rawSrt !== "string") {
      return res.status(400).json({ error: "Missing rawSrt" });
    }
    const result = prep.cleanSrt(rawSrt, settings || {});
    res.json(result);
  } catch (err) {
    console.error("Clean failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects?jwtToken= -> [{ id, name, identifier }, ...]
app.get("/api/projects", requireJwt, async (req, res) => {
  try {
    const { domain } = req.crowdinContext;
    const accessToken = await auth.getAccessToken(domain);
    const projects = await crowdin.listProjects(accessToken, domain);
    res.json({
      projects: projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })),
    });
  } catch (err) {
    console.error("List projects failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message });
  }
});

// POST /api/upload-to-project { jwtToken, projectId, fileName, srtContent } -> { file }
app.post("/api/upload-to-project", requireJwt, async (req, res) => {
  try {
    const { domain } = req.crowdinContext;
    const { projectId, fileName, srtContent } = req.body || {};
    if (!projectId || !fileName || !srtContent) {
      return res.status(400).json({ error: "Missing projectId, fileName, or srtContent" });
    }
    const accessToken = await auth.getAccessToken(domain);
    const storage = await crowdin.createStorage(accessToken, domain, fileName, srtContent);
    const file = await crowdin.addFile(accessToken, domain, projectId, {
      storageId: storage.id,
      name: fileName,
    });
    res.json({ file });
  } catch (err) {
    console.error("Upload to project failed:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message });
  }
});

app.listen(PORT, () => {
  console.log(`crowdin-subtitle-prep-app listening on :${PORT}`);
});
