// Deterministic Buffer post-copy generator. Built ONLY from the same
// allowlisted candidate fields the graphic itself uses — never from
// free text (description, ai_analysis) — so there is no path for an
// employer name or unsupported claim to end up in the post copy.

function buildPostCopy(candidate) {
  const lines = [];
  lines.push(candidate.title);

  const locationText = candidate.territory_display || candidate.location_display;
  const detailParts = [locationText, candidate.category, candidate.compensation_display].filter(Boolean);
  if (detailParts.length > 0) lines.push(detailParts.join(" · "));

  // Direct instruction: the same factual hook shown in the graphic
  // belongs in the post copy too, naturally, so the accompanying text
  // gives a real reason to click — not a second, different sentence,
  // the exact same already-verified, already-redaction-checked value.
  if (candidate.social_safe_hook) {
    lines.push(candidate.social_safe_hook);
  }

  lines.push("");
  lines.push("See the employer and complete job details on ROOK.");
  lines.push("Start your 3-day free trial:");
  lines.push(candidate.public_url);

  return lines.join("\n");
}

module.exports = { buildPostCopy };
