const { titleLooksRelevant } = require('../relevanceFilter');
const { registrableDomain } = require('./sourceResolver');

const adapters = {
  greenhouse: require('../adapters/greenhouse'),
  lever: require('../adapters/lever'),
  ashby: require('../adapters/ashby'),
  smartrecruiters: require('../adapters/smartrecruiters'),
  workable: require('../adapters/workable'),
  workday: require('../adapters/workday'),
  icims: require('../adapters/icims'),
  applicantpro: require('../adapters/applicantpro'),
  jobvite: require('../adapters/jobvite'),
  teamtailor: require('../adapters/teamtailor'),
  pinpoint: require('../adapters/pinpoint'),
  clinchtalent: require('../adapters/clinchtalent'),
  drupalcareers: require('../adapters/drupalcareers'),
  talentbrew: require('../adapters/talentbrew'),
  oraclehcm: require('../adapters/oraclehcm'),
  eightfold: require('../adapters/eightfold'),
  phenom: require('../adapters/phenom'),
  paylocity: require('../adapters/paylocity'),
  jazzhr: require('../adapters/jazzhr'),
  successfactors: require('../adapters/successfactors'),
  kula: require('../adapters/kula'),
  custom_html: require('../adapters/customHtml'),
  adp: require('../adapters/adp'),
  ukg: require('../adapters/ukg'),
};

const methodNames = {
  greenhouse: ['fetchGreenhouseJobs', 'normalizeGreenhouseJob'],
  lever: ['fetchLeverJobs', 'normalizeLeverJob'],
  ashby: ['fetchAshbyJobs', 'normalizeAshbyJob'],
  smartrecruiters: ['fetchSmartRecruitersJobs', 'normalizeSmartRecruitersJob'],
  workable: ['fetchWorkableJobs', 'normalizeWorkableJob'],
  workday: ['fetchWorkdayJobs', 'normalizeWorkdayJob'],
  icims: ['fetchIcimsJobs', 'normalizeIcimsJob'],
  applicantpro: ['fetchApplicantProJobs', 'normalizeApplicantProJob'],
  jobvite: ['fetchJobviteJobs', 'normalizeJobviteJob'],
  teamtailor: ['fetchTeamtailorJobs', 'normalizeTeamtailorJob'],
  pinpoint: ['fetchPinpointJobs', 'normalizePinpointJob'],
  clinchtalent: ['fetchClinchTalentJobs', 'normalizeClinchTalentJob'],
  drupalcareers: ['fetchDrupalCareersJobs', 'normalizeDrupalCareersJob'],
  talentbrew: ['fetchTalentBrewJobs', 'normalizeTalentBrewJob'],
  oraclehcm: ['fetchOracleHcmJobs', 'normalizeOracleHcmJob'],
  eightfold: ['fetchEightfoldJobs', 'normalizeEightfoldJob'],
  phenom: ['fetchPhenomJobs', 'normalizePhenomJob'],
  paylocity: ['fetchPaylocityJobs', 'normalizePaylocityJob'],
  jazzhr: ['fetchJazzHRJobs', null],
  successfactors: ['fetchSuccessFactorsJobs', 'normalizeSuccessFactorsJob'],
  kula: ['fetchKulaJobs', 'normalizeKulaJob'],
  custom_html: ['fetchCustomHtmlJobs', 'normalizeCustomHtmlJob'],
  adp: ['fetchAdpJobs', null],
  ukg: ['fetchUkgJobs', null],
};

async function dispatch(configuration, employer) {
  const module = adapters[configuration.ats_type];
  const names = methodNames[configuration.ats_type];
  if (!module || !names) throw new Error(`No discovery validator for ${configuration.ats_type}`);
  let rawJobs;
  if (['custom_html', 'adp', 'ukg', 'jazzhr'].includes(configuration.ats_type)) rawJobs = await module[names[0]](employer);
  else rawJobs = await module[names[0]](configuration.ats_identifier);
  let normalize = names[1] ? (raw) => module[names[1]](raw, employer) : (raw) => raw;
  if (configuration.ats_type === 'successfactors') {
    const host = configuration.ats_identifier.replace(/^https?:\/\//, '').replace(/\/$/, '');
    normalize = (raw) => module.normalizeSuccessFactorsJob(raw, employer, host);
  }
  return { rawJobs, normalize };
}

function sourceIsAnchored(job, configuration) {
  try {
    const jobUrl = new URL(job.source_url || job.url);
    const configuredUrl = new URL(configuration.source_url);
    const pathTenant = {
      greenhouse: /^\/([^/]+)/, lever: /^\/([^/]+)/, ashby: /^\/([^/]+)/,
      smartrecruiters: /^\/([^/]+)/, jobvite: /^\/([^/]+)/,
      kula: /^\/([^/]+)/,
    }[configuration.ats_type];
    if (pathTenant && registrableDomain(jobUrl.hostname) === registrableDomain(configuredUrl.hostname)) {
      const jobTenant = jobUrl.pathname.match(pathTenant)?.[1];
      const configuredTenant = configuredUrl.pathname.match(pathTenant)?.[1];
      return Boolean(jobTenant && configuredTenant && jobTenant.toLowerCase() === configuredTenant.toLowerCase());
    }
    if (configuration.ats_type === 'workday') {
      const site = configuration.ats_identifier.split('|')[2];
      return jobUrl.hostname === configuredUrl.hostname && jobUrl.pathname.split('/').includes(site);
    }
    if (configuration.ats_type === 'oraclehcm') return jobUrl.hostname === configuredUrl.hostname;
    if (configuration.ats_type === 'ukg') {
      const [, org, board] = configuration.ats_identifier.split('|');
      return jobUrl.hostname === configuredUrl.hostname && jobUrl.pathname.toLowerCase().includes(`/${org}/jobboard/${board}`.toLowerCase());
    }
    if (['icims', 'applicantpro', 'teamtailor', 'pinpoint', 'jazzhr', 'phenom', 'talentbrew', 'clinchtalent', 'drupalcareers', 'successfactors', 'eightfold'].includes(configuration.ats_type)) {
      return jobUrl.hostname === configuredUrl.hostname;
    }
    if (jobUrl.hostname === configuredUrl.hostname || registrableDomain(jobUrl.hostname) === registrableDomain(configuredUrl.hostname)) return true;
    const allowedPlatform = {
      greenhouse: 'greenhouse.io', lever: 'lever.co', ashby: 'ashbyhq.com', workable: 'workable.com',
      smartrecruiters: 'smartrecruiters.com', workday: 'myworkdayjobs.com', applicantpro: 'applicantpro.com',
      jobvite: 'jobvite.com', paylocity: 'paylocity.com', jazzhr: 'applytojob.com', kula: 'kula.ai',
      oraclehcm: 'oraclecloud.com', ukg: 'ultipro.com', adp: 'adp.com',
    }[configuration.ats_type];
    return Boolean(allowedPlatform && jobUrl.hostname.endsWith(allowedPlatform) && configuredUrl.hostname.endsWith(allowedPlatform));
  } catch {
    return false;
  }
}

function plausibleJob(job, configuration) {
  const title = String(job.title_original || job.title || '').trim();
  const description = String(job.description_text || job.description_html || '').trim();
  return Boolean(
    job && job.source_verified === true && job.status === 'active' && job.source_job_id &&
    title && description && titleLooksRelevant(title) && sourceIsAnchored(job, configuration)
  );
}

async function validateSource(configuration, candidate, { dispatchSource = dispatch } = {}) {
  const employer = {
    id: `discovery:${candidate.id || candidate.identity_key || 'candidate'}`,
    company_name: candidate.company_name,
    company_website: candidate.company_website,
    careers_url: configuration.source_url,
    industry: candidate.industry || null,
    ats_type: configuration.ats_type,
    ats_identifier: configuration.ats_identifier,
  };
  const started = Date.now();
  try {
    const { rawJobs, normalize } = await dispatchSource(configuration, employer);
    if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
      return { ok: false, status: 'NO_PLAUSIBLE_JOBS', raw_job_count: Array.isArray(rawJobs) ? rawJobs.length : null, elapsed_ms: Date.now() - started };
    }
    const jobs = [];
    const normalization_errors = [];
    for (const raw of rawJobs) {
      try { jobs.push(normalize(raw)); } catch (error) { normalization_errors.push(error.message); }
    }
    const plausible = jobs.filter((job) => plausibleJob(job, configuration));
    return {
      ok: plausible.length > 0,
      status: plausible.length ? 'PASS_VALIDATED_SOURCE' : 'NO_PLAUSIBLE_JOBS',
      raw_job_count: rawJobs.length,
      normalized_job_count: jobs.length,
      plausible_job_count: plausible.length,
      sample_jobs: plausible.slice(0, 3).map((job) => ({ source_job_id: job.source_job_id, title: job.title_original, source_url: job.source_url })),
      normalization_errors: normalization_errors.slice(0, 5),
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, status: 'SOURCE_VALIDATION_FAILED', error: error.message, elapsed_ms: Date.now() - started };
  }
}

module.exports = { dispatch, plausibleJob, sourceIsAnchored, validateSource, SUPPORTED_ATS_TYPES: Object.keys(methodNames) };
