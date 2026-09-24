// Pure logic for safely identifying the approved ROOK Buffer
// channels among whatever profiles the Buffer account has connected.
// Direct instruction: channels are identified by explicitly configured
// IDs (company LinkedIn/Facebook plus Gene's approved personal LinkedIn),
// never by guessing from a name match — configuration is the source of
// truth, this module's job is to validate that configuration against
// what Buffer actually reports, not to discover channels on its own.

// NOTE: Buffer's current GraphQL Channel type exposes only id, name,
// and service (verified against developers.buffer.com/guides/data-
// model.md) — there is no personal-vs-business-Page field in this
// API to check. The real, defensible safeguard here is exactly what
// direct instruction called for in the first place: a channel is only
// ever used if its ID exactly matches the explicitly configured
// BUFFER_ROOK_LINKEDIN_CHANNEL_ID / BUFFER_ROOK_FACEBOOK_CHANNEL_ID —
// there is no name-matching or type-guessing anywhere in this module,
// so a personal profile can only ever be used if someone deliberately
// configures its ID, which is a configuration-time human decision this
// code cannot see into, not something to paper over with a heuristic
// checking a field the API doesn't actually provide.

function describeChannel(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    service: channel.service || null,
    displayName: channel.name || "(unknown)",
  };
}

/**
 * Given the full list of Buffer channels and the configured
 * channel IDs, returns exactly which channels to use, or a clear
 * list of errors if configuration is missing, ambiguous, or points at
 * the wrong platform.
 */
function identifyRookChannels(channels, { linkedinChannelId, facebookChannelId }) {
  const errors = [];
  const byId = new Map((channels || []).map((c) => [String(c.id), c]));

  if (!linkedinChannelId) errors.push("BUFFER_ROOK_LINKEDIN_CHANNEL_ID is not configured");
  if (!facebookChannelId) errors.push("BUFFER_ROOK_FACEBOOK_CHANNEL_ID is not configured");
  if (linkedinChannelId && facebookChannelId && linkedinChannelId === facebookChannelId) {
    errors.push("BUFFER_ROOK_LINKEDIN_CHANNEL_ID and BUFFER_ROOK_FACEBOOK_CHANNEL_ID must not be the same channel");
  }

  let linkedin = null;
  let facebook = null;

  if (linkedinChannelId) {
    linkedin = byId.get(String(linkedinChannelId)) || null;
    if (!linkedin) {
      errors.push(`No Buffer channel found matching BUFFER_ROOK_LINKEDIN_CHANNEL_ID (${linkedinChannelId})`);
    } else if (String(linkedin.service || "").toLowerCase() !== "linkedin") {
      errors.push(`Channel configured as BUFFER_ROOK_LINKEDIN_CHANNEL_ID is not a LinkedIn channel (service: ${linkedin.service})`);
    }
  }

  if (facebookChannelId) {
    facebook = byId.get(String(facebookChannelId)) || null;
    if (!facebook) {
      errors.push(`No Buffer channel found matching BUFFER_ROOK_FACEBOOK_CHANNEL_ID (${facebookChannelId})`);
    } else if (String(facebook.service || "").toLowerCase() !== "facebook") {
      errors.push(`Channel configured as BUFFER_ROOK_FACEBOOK_CHANNEL_ID is not a Facebook channel (service: ${facebook.service})`);
    }
  }

  return {
    ok: errors.length === 0 && Boolean(linkedin) && Boolean(facebook),
    linkedin: describeChannel(linkedin),
    facebook: describeChannel(facebook),
    errors,
  };
}

function identifyOptionalPersonalLinkedin(channels, personalLinkedinChannelId, companyChannelIds = []) {
  if (!personalLinkedinChannelId) return { ok: false, channel: null, error: "BUFFER_GENE_LINKEDIN_CHANNEL_ID is not configured" };
  const channel = (channels || []).find(c => String(c.id) === String(personalLinkedinChannelId));
  if (!channel) return { ok: false, channel: null, error: "Gene LinkedIn Buffer channel was not found" };
  if (String(channel.service || "").toLowerCase() !== "linkedin") return { ok: false, channel: null, error: "Gene Buffer destination is not a LinkedIn channel" };
  if (companyChannelIds.map(String).includes(String(channel.id))) return { ok: false, channel: null, error: "Gene LinkedIn channel must be distinct from company channels" };
  return { ok: true, channel: { ...describeChannel(channel), organizationId: channel.organizationId || null }, error: null };
}

module.exports = { identifyRookChannels, identifyOptionalPersonalLinkedin, describeChannel };
