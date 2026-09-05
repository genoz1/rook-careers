// Thin wrapper around Buffer's official REST API (v1,
// https://api.bufferapp.com/1) — the current, documented API surface
// as of this writing. OAuth2 bearer token auth. No other Buffer
// functionality is used or needed for this system.
//
// Deliberately dependency-injectable (an httpFetch function can be
// passed in) so the publishing worker's logic is testable without any
// real network call — the default is Node's native fetch (Node 18+).

const BUFFER_API_BASE = "https://api.bufferapp.com/1";

async function bufferRequest(accessToken, method, path, body, { httpFetch = fetch } = {}) {
  if (!accessToken) {
    throw new Error("BUFFER_ACCESS_TOKEN is not configured — refusing to call the Buffer API without it");
  }
  const res = await httpFetch(`${BUFFER_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    // Buffer's error responses put a human-readable message in
    // `.error` or `.message` — surfaced without ever including the
    // access token itself (it's never present in a response body,
    // but this is deliberate defense-in-depth: only known-safe fields
    // are included in the thrown error).
    const message = data?.error || data?.message || `Buffer API error (HTTP ${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.bufferResponse = data;
    throw err;
  }
  return data;
}

/**
 * Lists every profile (channel) connected to this Buffer account —
 * the safe channel-discovery primitive. Each profile includes id,
 * service (platform: 'linkedin', 'facebook', etc.), and a display
 * name — never the access token itself.
 */
async function listProfiles(accessToken, opts) {
  const data = await bufferRequest(accessToken, "GET", "/profiles.json", null, opts);
  return Array.isArray(data) ? data : [];
}

async function getProfile(accessToken, profileId, opts) {
  return bufferRequest(accessToken, "GET", `/profiles/${encodeURIComponent(profileId)}.json`, null, opts);
}

/**
 * Creates a new Buffer update (post). Buffer fetches the image from
 * the given public HTTPS URL itself — no binary upload from this
 * process, which is why the graphic must already be written to a
 * stable public URL (see backend/socialGraphicStorage.js) before this
 * is called.
 */
async function createUpdate(accessToken, { profileIds, text, photoUrl, now = true, scheduledAt }, opts) {
  if (!Array.isArray(profileIds) || profileIds.length === 0) {
    throw new Error("createUpdate requires at least one profile ID");
  }
  const body = {
    profile_ids: profileIds,
    text,
    now,
  };
  if (photoUrl) body.media = { photo: photoUrl, thumbnail: photoUrl };
  if (!now && scheduledAt) body.scheduled_at = scheduledAt;

  return bufferRequest(accessToken, "POST", "/updates/create.json", body, opts);
}

async function getUpdate(accessToken, updateId, opts) {
  return bufferRequest(accessToken, "GET", `/updates/${encodeURIComponent(updateId)}.json`, null, opts);
}

module.exports = { BUFFER_API_BASE, listProfiles, getProfile, createUpdate, getUpdate };
