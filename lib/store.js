/**
 * Storage for OAuth installation credentials, backed by Upstash Redis.
 * Same pattern as the sibling crowdin-subtitle-timing-app (see that repo's
 * lib/store.js for the full rationale on why Redis rather than local disk).
 *
 * Uses a distinct key ("prep-installations") so this app can safely share
 * the same Upstash database as the sibling app (different key, no
 * collision) rather than requiring a second free-tier Redis signup - the
 * two apps remain fully independent Crowdin App installations either way.
 */

const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();
const KEY = "prep-installations";

async function getInstallations() {
  const all = await redis.get(KEY);
  return all || {};
}

async function saveInstallation(domain, record) {
  const all = await getInstallations();
  all[domain] = { ...all[domain], ...record };
  await redis.set(KEY, all);
  return all[domain];
}

async function getInstallation(domain) {
  const all = await getInstallations();
  return all[domain];
}

async function removeInstallation(domain) {
  const all = await getInstallations();
  delete all[domain];
  await redis.set(KEY, all);
}

module.exports = { getInstallations, saveInstallation, getInstallation, removeInstallation };
