// Permanent source/employer policy for boards that must never enter ROOK
// customer-visible inventory. Petco retail careers were enrolled under the
// mislabeled discovery name "Vet Receptionists" and flooded Sales Associate
// store jobs into the feed.

const BLOCKED_REGISTRABLE_DOMAINS = new Set([
  'petco.com',
  'chewy.com',
]);

const BLOCKED_HOST_SUFFIXES = [
  'petco.com',
  'chewy.com',
];

const BLOCKED_COMPANY_NAMES = new Set([
  'vet receptionists',
  'petco',
  'chewy',
]);

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
    .toLowerCase().replace(/[®™©]/g, '')
    .replace(/\b(incorporated|corporation|company|holdings|limited|inc|corp|llc|ltd|plc|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function hostOf(value) {
  if (!value) return '';
  try {
    const raw = String(value).trim();
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(value).toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function isBlockedHost(value) {
  const host = hostOf(value);
  if (!host) return false;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isBlockedCompanyName(value) {
  const name = normalizeCompanyName(value);
  if (!name) return false;
  if (BLOCKED_COMPANY_NAMES.has(name)) return true;
  // Exact retail pet brands that are not field-sales employers for ROOK.
  return /^(?:vet receptionists|petco|chewy)(?:\s|$)/.test(name);
}

function blockedEmployerReason(employerOrSignal = {}) {
  const values = [
    employerOrSignal.company_name,
    employerOrSignal.careers_url,
    employerOrSignal.source_url,
    employerOrSignal.company_website,
    employerOrSignal.ats_identifier,
    employerOrSignal.job_url,
    employerOrSignal.company_domain,
  ];
  if (isBlockedCompanyName(employerOrSignal.company_name)) {
    return 'Blocked pet retail employer (not a ROOK field-sales source)';
  }
  for (const value of values) {
    if (isBlockedHost(value)) {
      return 'Blocked pet retail careers host (Petco/Chewy store jobs)';
    }
  }
  // Talentbrew/Radancy identifiers are often bare hosts.
  if (isBlockedHost(employerOrSignal.ats_identifier)) {
    return 'Blocked pet retail careers host (Petco/Chewy store jobs)';
  }
  return null;
}

function isBlockedEmployerSource(employerOrSignal) {
  return Boolean(blockedEmployerReason(employerOrSignal));
}

module.exports = {
  BLOCKED_REGISTRABLE_DOMAINS,
  BLOCKED_COMPANY_NAMES,
  blockedEmployerReason,
  isBlockedEmployerSource,
  isBlockedHost,
  isBlockedCompanyName,
  normalizeCompanyName,
};
