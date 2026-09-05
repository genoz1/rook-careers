// Pure logic for safely identifying the two approved ROOK Buffer
// channels among whatever profiles the Buffer account has connected.
// Direct instruction: channels are identified by explicitly configured
// IDs (BUFFER_ROOK_LINKEDIN_CHANNEL_ID / BUFFER_ROOK_FACEBOOK_CHANNEL_ID),
// never by guessing from a name match — configuration is the source of
// truth, this module's job is to validate that configuration against
// what Buffer actually reports, not to discover channels on its own.

// Buffer's profile objects don't always expose a clean "is this a
// personal profile vs. a business Page" flag identically across every
// platform, so this is a best-effort secondary check — the actual
// safety guarantee is that only a channel matching one of the two
// explicitly configured IDs is ever used at all, regardless of what
// this heuristic concludes.
function looksLikePersonalProfile(profile) {
  const serviceType = String(profile?.service_type || "").toLowerCase();
  if (serviceType && serviceType !== "page" && serviceType !== "company") return true;
  return false;
}

function describeChannel(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    service: profile.service || null,
    displayName: profile.formatted_username || profile.service_username || profile.username || "(unknown)",
    avatar: profile.avatar || null,
  };
}

/**
 * Given the full list of Buffer profiles and the two configured
 * channel IDs, returns exactly which two profiles to use, or a clear
 * list of errors if configuration is missing, ambiguous, or points at
 * something that doesn't look like the intended platform/page.
 */
function identifyRookChannels(profiles, { linkedinChannelId, facebookChannelId }) {
  const errors = [];
  const byId = new Map((profiles || []).map((p) => [String(p.id), p]));

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
    } else {
      if (String(linkedin.service || "").toLowerCase() !== "linkedin") {
        errors.push(`Channel configured as BUFFER_ROOK_LINKEDIN_CHANNEL_ID is not a LinkedIn channel (service: ${linkedin.service})`);
      }
      if (looksLikePersonalProfile(linkedin)) {
        errors.push("Channel configured as BUFFER_ROOK_LINKEDIN_CHANNEL_ID does not appear to be a business Page — refusing to post to what may be a personal profile");
      }
    }
  }

  if (facebookChannelId) {
    facebook = byId.get(String(facebookChannelId)) || null;
    if (!facebook) {
      errors.push(`No Buffer channel found matching BUFFER_ROOK_FACEBOOK_CHANNEL_ID (${facebookChannelId})`);
    } else {
      if (String(facebook.service || "").toLowerCase() !== "facebook") {
        errors.push(`Channel configured as BUFFER_ROOK_FACEBOOK_CHANNEL_ID is not a Facebook channel (service: ${facebook.service})`);
      }
      if (looksLikePersonalProfile(facebook)) {
        errors.push("Channel configured as BUFFER_ROOK_FACEBOOK_CHANNEL_ID does not appear to be a business Page — refusing to post to what may be a personal profile");
      }
    }
  }

  return {
    ok: errors.length === 0 && Boolean(linkedin) && Boolean(facebook),
    linkedin: describeChannel(linkedin),
    facebook: describeChannel(facebook),
    errors,
  };
}

module.exports = { identifyRookChannels, describeChannel, looksLikePersonalProfile };
