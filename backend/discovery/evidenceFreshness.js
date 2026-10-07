const { createHash } = require('node:crypto');

const MAX_SIGNAL_FINGERPRINTS = 32;

function canonicalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|trk|trackingid|ref|refid|source|src)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function currentJobEvidence(signal) {
  const sourceSignalId = String(signal?.source_signal_id || '').trim() || null;
  const jobUrl = canonicalUrl(signal?.job_url);
  if (!sourceSignalId && !jobUrl) return null;
  return {
    signal_source: String(signal?.signal_source || '').trim() || null,
    source_signal_id: sourceSignalId,
    job_url: jobUrl,
    job_title: String(signal?.job_title || '').replace(/\s+/g, ' ').trim() || null,
    location: String(signal?.location || signal?.job_location || '').replace(/\s+/g, ' ').trim() || null,
  };
}

function materialEvidenceFingerprint(signal) {
  const job = currentJobEvidence(signal);
  const official = {
    company_domain: String(signal?.company_domain || '').trim().toLowerCase() || null,
    company_website: canonicalUrl(signal?.company_website || signal?.company_url),
    careers_url: canonicalUrl(signal?.careers_url),
    resolved_website: canonicalUrl(signal?.source_evidence?.website_resolution?.website),
  };
  if (!job && !Object.values(official).some(Boolean)) return null;
  const stableJobIdentity = job?.source_signal_id
    ? `${job.signal_source || ''}\n${job.source_signal_id}`
    : job ? `${job.signal_source || ''}\n${job.job_url}` : null;
  return createHash('sha256').update(JSON.stringify({ stable_job_identity: stableJobIdentity, official })).digest('hex');
}

function recordedFingerprints(payload) {
  const recorded = payload?._discovery?.material_evidence_fingerprints || payload?._discovery?.current_job_fingerprints;
  const values = Array.isArray(recorded) ? recorded.filter((value) => typeof value === 'string') : [];
  const legacy = materialEvidenceFingerprint(payload);
  if (legacy) values.push(legacy);
  return [...new Set(values)];
}

function assessSignalFreshness(existingPayload, incomingPayload) {
  const fingerprint = materialEvidenceFingerprint(incomingPayload);
  const seen = recordedFingerprints(existingPayload);
  return {
    fingerprint,
    fresh: Boolean(fingerprint && !seen.includes(fingerprint)),
    evidence: currentJobEvidence(incomingPayload),
  };
}

function mergeSignalPayload(existingPayload, incomingPayload, observedAt) {
  const assessment = assessSignalFreshness(existingPayload, incomingPayload);
  const fingerprints = recordedFingerprints(existingPayload);
  if (assessment.fingerprint && !fingerprints.includes(assessment.fingerprint)) fingerprints.push(assessment.fingerprint);
  return {
    ...(existingPayload || {}),
    ...(incomingPayload || {}),
    _discovery: {
      ...(existingPayload?._discovery || {}),
      ...(incomingPayload?._discovery || {}),
      material_evidence_fingerprints: fingerprints.slice(-MAX_SIGNAL_FINGERPRINTS),
      ...(assessment.fresh ? { last_material_evidence_at: observedAt } : {}),
    },
  };
}

module.exports = {
  assessSignalFreshness,
  currentJobEvidence,
  materialEvidenceFingerprint,
  mergeSignalPayload,
};
