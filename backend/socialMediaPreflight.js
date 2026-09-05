// Preflight media check — direct instruction: before ever contacting
// Buffer, fetch the EXACT public URL a generated graphic was written
// to and verify it is genuinely fetchable the way Buffer itself would
// fetch it (a plain, unauthenticated GET) — not just that a local file
// exists on whatever disk the CLI happened to run on. This is what
// actually catches the reported "Image could not be read from its
// URL" failure locally, with a clear reason, instead of finding out
// only after Buffer has already rejected the post.
//
// Dependency-injectable httpFetch so this is fully testable without
// any real network call.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {string} url - the exact public URL to verify
 * @returns {Promise<{ok: boolean, reason?: string, contentType?: string, byteLength?: number}>}
 */
async function preflightCheckMedia(url, { httpFetch = fetch } = {}) {
  let res;
  try {
    res = await httpFetch(url, { method: "GET", redirect: "manual" });
  } catch (err) {
    return { ok: false, reason: `Could not reach media URL: ${err.message}` };
  }

  // redirect: "manual" surfaces a redirect as a 3xx status rather than
  // silently following it — direct instruction: the URL must be
  // fetchable "without... redirects." A genuinely stable, direct URL
  // should never need one.
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, reason: `Media URL redirected (HTTP ${res.status}) instead of serving the file directly` };
  }
  if (res.status !== 200) {
    return { ok: false, reason: `Media URL returned HTTP ${res.status}, expected 200` };
  }

  const contentType = typeof res.headers?.get === "function" ? res.headers.get("content-type") : res.headers?.["content-type"];
  if (!contentType || !contentType.toLowerCase().startsWith("image/png")) {
    return { ok: false, reason: `Media URL returned Content-Type "${contentType || "(none)"}", expected image/png` };
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) {
    return { ok: false, reason: "Media URL returned an empty body" };
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "Media URL body does not start with a valid PNG signature" };
  }

  return { ok: true, contentType, byteLength: buffer.length };
}

module.exports = { preflightCheckMedia, PNG_SIGNATURE };
