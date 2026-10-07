const { createHash } = require('node:crypto');
const { detectFromUrl, registrableDomain, resolveOfficialSource } = require('./sourceResolver');
const { validateSource } = require('./sourceValidator');

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
    .toLowerCase().replace(/[®™©]/g, '')
    .replace(/\b(incorporated|corporation|company|holdings|limited|inc|corp|llc|ltd|plc|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function candidateDomain(signal) {
  for (const value of [signal.company_domain, signal.company_website, signal.company_url]) {
    if (!value) continue;
    const domain = registrableDomain(value.includes('://') ? value : `https://${value}`);
    if (domain) return domain;
  }
  return null;
}

function identityKey(signal) {
  const name = normalizeCompanyName(signal.company_name);
  return createHash('sha256').update(`name:${name}`).digest('hex');
}

function validateSignal(signal) {
  if (!signal || typeof signal !== 'object') throw new Error('Discovery signal must be an object');
  if (!String(signal.company_name || '').trim()) throw new Error('Discovery signal requires company_name');
  if (!String(signal.signal_source || '').trim()) throw new Error('Discovery signal requires signal_source');
}

function directConfiguration(signal) {
  for (const value of [signal.careers_url, signal.job_url, signal.source_url]) {
    const detected = value && detectFromUrl(value);
    if (detected) return detected;
  }
  return null;
}

function employerMatches(employer, candidate, configuration = null) {
  const sameName = normalizeCompanyName(employer.company_name) === candidate.normalized_company_name;
  const employerDomain = registrableDomain(employer.company_website || employer.careers_url || '');
  const sameDomain = Boolean(candidate.company_domain && employerDomain && candidate.company_domain === employerDomain);
  const sameSource = Boolean(configuration && employer.ats_type === configuration.ats_type && employer.ats_identifier === configuration.ats_identifier);
  return sameName || sameDomain || sameSource;
}

function retryAt(now, days) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

class EmployerDiscoveryPipeline {
  constructor({ store, resolveSource = resolveOfficialSource, validate = validateSource, now = () => new Date() }) {
    this.store = store;
    this.resolveSource = resolveSource;
    this.validate = validate;
    this.now = now;
  }

  async processSignal(signal, { force = false, candidateId = null } = {}) {
    validateSignal(signal);
    const now = this.now();
    const normalizedName = normalizeCompanyName(signal.company_name);
    const domain = candidateDomain(signal);
    const received = await this.store.receiveCandidate({
      identity_key: identityKey(signal),
      company_name: String(signal.company_name).trim(),
      normalized_company_name: normalizedName,
      company_domain: domain,
      company_website: signal.company_website || signal.company_url || (signal.company_domain ? `https://${signal.company_domain}` : null),
      careers_url: signal.careers_url || null,
      job_url: signal.job_url || null,
      industry: signal.industry || null,
      signal_source: String(signal.signal_source).trim(),
      signal_payload: signal,
      status: 'received',
      last_signal_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    let candidate = received.candidate;
    if (candidateId && candidate.id !== candidateId) throw new Error('Explicit force target did not match the signal candidate');
    if (['enrolled', 'existing'].includes(candidate.status)) return { status: candidate.status, candidate, duplicate: true };
    if (!force && candidate.next_attempt_at && Date.parse(candidate.next_attempt_at) > +now) return { status: 'deferred', candidate, duplicate: received.duplicate };

    const direct = directConfiguration(signal);
    const employers = await this.store.listEmployers();
    const known = employers.find((employer) => employerMatches(employer, candidate, direct));
    if (known) {
      const externalJobEvidence = signal.job_url ? {
        investigation_required: true,
        reason: 'EXTERNAL_JOB_SIGNAL_FOR_MONITORED_EMPLOYER',
        job_url: signal.job_url,
        job_title: signal.job_title || null,
        signal_source: signal.signal_source,
        observed_at: now.toISOString(),
      } : null;
      candidate = await this.store.updateCandidate(candidate.id, {
        status: 'existing', employer_id: known.id, last_error: null, updated_at: now.toISOString(), next_attempt_at: null,
        evidence: externalJobEvidence ? { ...(candidate.evidence || {}), external_job_signal: externalJobEvidence } : (candidate.evidence || {}),
        ...(direct ? { detected_ats_type: direct.ats_type, detected_ats_identifier: direct.ats_identifier } : {}),
      });
      return { status: 'existing', candidate, employer: known };
    }

    candidate = await this.store.updateCandidate(candidate.id, {
      status: 'resolving', attempt_count: (candidate.attempt_count || 0) + 1,
      last_attempt_at: now.toISOString(), updated_at: now.toISOString(), last_error: null,
    });

    let resolved;
    try {
      resolved = await this.resolveSource({ ...signal, company_website: candidate.company_website });
    } catch (error) {
      const transient = !['NEEDS_OFFICIAL_DOMAIN', 'BAD_OFFICIAL_URL', 'OFFICIAL_DOMAIN_MISMATCH', 'COMPANY_IDENTITY_MISMATCH', 'SEARCH_IDENTITY_NOT_VERIFIED', 'NO_OFFICIAL_CAREERS_LINK', 'UNSUPPORTED_SOURCE'].includes(error.code);
      candidate = await this.store.updateCandidate(candidate.id, {
        status: transient ? 'retryable' : 'unresolved',
        last_error: error.message,
        evidence: error.evidence || {},
        validation_status: error.code || 'RESOLUTION_FAILED',
        next_attempt_at: retryAt(now, transient ? 1 : 7),
        updated_at: now.toISOString(),
      });
      return { status: candidate.status, candidate };
    }

    candidate = await this.store.updateCandidate(candidate.id, {
      status: 'validating', evidence: resolved.evidence, company_domain: resolved.official_domain,
      company_website: resolved.official_url, careers_url: resolved.careers_pages[0] || candidate.careers_url,
      updated_at: now.toISOString(),
    });

    const validationAttempts = [];
    let passed = null;
    for (const configuration of resolved.configurations) {
      const sourceOwner = await this.store.findCandidateBySource(configuration.ats_type, configuration.ats_identifier);
      if (sourceOwner && sourceOwner.id !== candidate.id) {
        validationAttempts.push({ configuration, result: { ok: false, status: 'SOURCE_ALREADY_ENROLLED' } });
        continue;
      }
      const result = await this.validate(configuration, candidate);
      validationAttempts.push({ configuration, result });
      if (!result.ok) continue;
      if (!passed) passed = { configuration, result };
      if ((result.plausible_job_count || 0) > 0) { passed = { configuration, result }; break; }
    }

    if (passed) {
      const { configuration, result } = passed;
      const currentEmployers = await this.store.listEmployers();
      const duplicateEmployer = currentEmployers.find((employer) => employerMatches(employer, candidate, configuration));
      if (duplicateEmployer) {
        candidate = await this.store.updateCandidate(candidate.id, {
          status: 'existing', employer_id: duplicateEmployer.id,
          detected_ats_type: configuration.ats_type, detected_ats_identifier: configuration.ats_identifier,
          validation_status: result.status, validation_result: result, next_attempt_at: null, last_error: null,
          updated_at: now.toISOString(),
        });
        return { status: 'existing', candidate, employer: duplicateEmployer, validation: result };
      }

      // This is the sole active-employer creation path. It is deliberately
      // inside result.ok so confidence, provider assertions, or AI output can
      // never bypass a successful live adapter validation.
      const employer = await this.store.enrollEmployer(candidate, configuration);
      candidate = await this.store.updateCandidate(candidate.id, {
        status: 'enrolled', employer_id: employer.id,
        detected_ats_type: configuration.ats_type, detected_ats_identifier: configuration.ats_identifier,
        validation_status: result.status, validation_result: result, next_attempt_at: null, last_error: null,
        updated_at: now.toISOString(),
      });
      return { status: 'enrolled', candidate, employer, validation: result };
    }

    candidate = await this.store.updateCandidate(candidate.id, {
      status: 'retryable',
      last_error: 'Detected source configurations did not pass machine validation',
      validation_status: 'VALIDATION_FAILED', validation_result: { attempts: validationAttempts },
      next_attempt_at: retryAt(now, 1), updated_at: now.toISOString(),
    });
    return { status: 'retryable', candidate, validation_attempts: validationAttempts };
  }
}

module.exports = {
  EmployerDiscoveryPipeline,
  normalizeCompanyName,
  candidateDomain,
  identityKey,
  employerMatches,
  validateSignal,
};
