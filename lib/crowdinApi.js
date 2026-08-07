/**
 * Thin wrapper around the parts of the Crowdin REST API this app needs:
 * listing the org's projects (for the "Upload to project" dropdown) and
 * pushing a cleaned .srt into one of them as a new source file.
 * Docs: https://developer.crowdin.com/api/v2/
 */

const axios = require("axios");

/** Crowdin Enterprise orgs are served from a domain-scoped API host. */
function client(accessToken, domain) {
  const baseURL = domain ? `https://${domain}.api.crowdin.com/api/v2` : "https://api.crowdin.com/api/v2";
  return axios.create({
    baseURL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** List every project the installation's user can see, across pages. */
async function listProjects(accessToken, domain) {
  const api = client(accessToken, domain);
  const results = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const { data } = await api.get("/projects", { params: { limit, offset } });
    results.push(...data.data.map((d) => d.data));
    if (data.data.length < limit) break;
    offset += limit;
  }
  return results;
}

/**
 * Upload raw file content as a Storage resource - the required first step
 * before either creating a new source file or updating an existing one.
 * Per https://developer.crowdin.com/api/v2/#operation/api.storages.post:
 * the request body is the raw file bytes (not JSON), with the filename
 * passed via the `Crowdin-API-FileName` header.
 */
async function createStorage(accessToken, domain, fileName, content) {
  const api = client(accessToken, domain);
  const { data } = await api.post("/storages", content, {
    headers: {
      "Crowdin-API-FileName": encodeURIComponent(fileName),
      "Content-Type": "application/octet-stream",
    },
  });
  return data.data; // { id, fileName }
}

/** Create a brand-new source file in a project from an already-uploaded Storage resource. */
async function addFile(accessToken, domain, projectId, { storageId, name, directoryId, branchId }) {
  const api = client(accessToken, domain);
  const payload = { storageId, name };
  if (directoryId) payload.directoryId = directoryId;
  if (branchId) payload.branchId = branchId;
  const { data } = await api.post(`/projects/${projectId}/files`, payload);
  return data.data;
}

module.exports = { listProjects, createStorage, addFile };
