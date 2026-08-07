/**
 * Crowdin "crowdin_app" OAuth helper - identical pattern to the sibling
 * crowdin-subtitle-timing-app repo's lib/crowdinAuth.js (see that file's
 * comments for the full flow explanation). Duplicated rather than shared
 * since this is a fully independent Crowdin App with its own OAuth
 * Application registration (its own CROWDIN_CLIENT_ID/SECRET) and its own
 * per-installation credentials store.
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");
const store = require("./store");

const OAUTH_TOKEN_URL = "https://accounts.crowdin.com/oauth/token";

async function exchangeForAccessToken(installation) {
  const { data } = await axios.post(OAUTH_TOKEN_URL, {
    grant_type: "crowdin_app",
    client_id: process.env.CROWDIN_CLIENT_ID || installation.clientId,
    client_secret: process.env.CROWDIN_CLIENT_SECRET,
    app_id: installation.appId,
    app_secret: installation.appSecret,
    domain: installation.domain,
    user_id: installation.userId,
  });
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return store.saveInstallation(installation.domain, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: expiresAt,
  });
}

/** Returns a valid access token for the given domain, refreshing if needed. */
async function getAccessToken(domain) {
  let installation = await store.getInstallation(domain);
  if (!installation) {
    throw new Error(`No installation found for domain "${domain}". Is the app installed?`);
  }
  const isExpired =
    !installation.accessToken ||
    !installation.accessTokenExpiresAt ||
    Date.now() >= installation.accessTokenExpiresAt;

  if (isExpired) {
    installation = await exchangeForAccessToken(installation);
  }
  return installation.accessToken;
}

/** Verify the jwtToken Crowdin appends to every iframe request. */
async function verifyJwt(jwtToken) {
  const secret = process.env.CROWDIN_CLIENT_SECRET;
  if (!secret) {
    throw new Error("Server misconfigured: CROWDIN_CLIENT_SECRET is not set");
  }
  return jwt.verify(jwtToken, secret, { algorithms: ["HS256"] });
}

module.exports = { getAccessToken, verifyJwt, exchangeForAccessToken };
