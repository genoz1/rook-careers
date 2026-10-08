// Shared guard for automated social copy (Buffer company/personal posts,
// resources social_copy, industry-news captions). ROOK is paid-only with
// no free trial. Automated posts must not pitch free trials, "no credit
// card" access, or recite checkout prices — send people to ROOK instead.
// Job posts may still show verified compensation; use assertNoStalePromoClaims
// (trial language only) for those.

// Dollar amounts sit outside the \b wrap — `$` is non-word, so `\b$0` never matches.
const STALE_PROMO_RE = /(?:\b(?:free\s*trial|free\s*access|try\s+rook(?:\s+today)?\s+for\s+free|start\s+(?:my\s+)?free(?:\s+trial)?|24[\s-]*hours?\s+(?:of\s+)?(?:full\s+)?(?:free\s+)?access|no\s+credit\s+card(?:\s+required)?|complimentary\s+access|zero\s+dollars?)\b|\$\s*0(?:\.00)?\b)/i;

// Checkout / membership price pitches — not verified job compensation.
const PRICING_PITCH_RE = /\$\s*\d+(?:\.\d{2})?|\b(?:2[\s-]*day\s+pass|3[\s-]*month\s+pass|monthly\s+(?:plan|membership|subscription)|first\s+(?:30\s+)?(?:paid\s+)?(?:days?|month)\b.*(?:\$|\d)|then\s+\$?\d[\d.]*(?:\s*\/\s*month|\s*per\s+month)?)\b/i;

function findStalePromoClaim(text, { allowPricing = false } = {}) {
  const value = String(text || '');
  if (!value.trim()) return null;
  if (STALE_PROMO_RE.test(value)) return 'stale free-trial / free-access claim';
  if (!allowPricing && PRICING_PITCH_RE.test(value)) return 'pricing or plan-price pitch';
  return null;
}

function assertNoStalePromoClaims(text, label = 'social copy', options) {
  const reason = findStalePromoClaim(text, options);
  if (reason) throw Error(`${label} must not include ${reason}`);
  return text;
}

module.exports = {
  STALE_PROMO_RE,
  PRICING_PITCH_RE,
  findStalePromoClaim,
  assertNoStalePromoClaims,
};
