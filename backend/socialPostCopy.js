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

  lines.push("");
  lines.push("See the employer and complete job details on ROOK.");
  lines.push("Start your 3-day free trial:");
  lines.push(candidate.public_url);

  return lines.join("\n");
}

module.exports = { buildPostCopy };
