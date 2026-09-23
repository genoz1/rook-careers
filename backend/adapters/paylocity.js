// Paylocity Recruiting career-site adapter
//
// Paylocity's bulk partner-integration API is genuinely gated (requires
// a customer-sponsored Partner Program agreement) - but that's a
// different thing from the per-customer Job Feed endpoint their own
// careers-widget calls internally, which Paylocity documents directly:
// https://recruiting.paylocity.com/Recruiting/v2/api/feed/documentation
// GET https://recruiting.paylocity.com/recruiting/v2/api/feed/jobs/{guid}
// returns real, complete JSON (title, description, location, salary,
// department, applyUrl) with no authentication - confirmed against
// Paylocity's own documented example response, not reverse-engineered.
//
// The {guid} is specific to each Paylocity customer, but conveniently
// it's directly visible in that employer's own public careers URL, e.g.
// https://recruiting.paylocity.com/recruiting/jobs/All/4bcae427-e9e7-4d6d-9772-73ef70c3a278/Adapt-Health-LLC
// so no separate discovery step is needed beyond finding that URL once.
//
// You only need the GUID itself, e.g.:
//   ats_identifier = "4bcae427-e9e7-4d6d-9772-73ef70c3a278"

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...options.headers } });
  } finally {
    clearTimeout(timer);
  }
}

function parseBoardData(html) {
  const $ = require('cheerio').load(html);
  for (const script of $('script').toArray()) {
    const match = $(script).text().match(/window\.pageData\s*=\s*(\{[\s\S]*\})\s*;/);
    if (!match) continue;
    const data = JSON.parse(match[1]);
    if (!Array.isArray(data.Jobs) || !data.ModuleTitle) throw new Error('Paylocity board schema missing Jobs or employer identity');
    return data;
  }
  throw new Error('Paylocity board data unavailable; not a verified zero');
}

async function fetchPaylocityJobs(guid) {
  const { getHtml } = require('./htmlSource');
  const { titleLooksRelevant } = require('../relevanceFilter');
  const cheerio = require('cheerio');
  const data = parseBoardData(await getHtml('https://recruiting.paylocity.com/recruiting/jobs/All/' + guid));
  const jobs = [];
  jobs.incompleteSnapshot = false;
  jobs.sourceEmployerName = data.ModuleTitle;
  for (const item of data.Jobs) {
    if (!item.JobId || !item.JobTitle) { jobs.incompleteSnapshot = true; continue; }
    if (!titleLooksRelevant(item.JobTitle) || item.IsInternal) continue;
    const url = 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/' + item.JobId;
    try {
      const $ = cheerio.load(await getHtml(url));
      const detail = $('.job-preview-details').clone();
      detail.find('.mobile-apply-btn').remove();
      const description = detail.html();
      if (!description || !$('.job-preview-title').text().trim()) throw new Error('Missing Paylocity detail');
      const loc = item.JobLocation || {};
      jobs.push({ jobId: item.JobId, title: item.JobTitle, description, displayUrl: url, applyUrl: url,
        jobLocation: { city: loc.City, state: loc.State, country: loc.Country, locationDisplayName: item.LocationName },
        publishedDate: item.PublishedDate });
    } catch { jobs.incompleteSnapshot = true; }
  }
  return jobs;
}

/**
 * Convert one raw Paylocity job into ROOK's canonical job shape.
 * Field names (jobId, title, description, applyUrl, displayUrl,
 * jobLocation, salaryDescription, publishedDate) match Paylocity's own
 * documented example response directly.
 */
function normalizePaylocityJob(raw, employer) {
  const jobUrl = raw.displayUrl || raw.applyUrl;
  const loc = raw.jobLocation || {};
  const countries = require('i18n-iso-countries');
  const countryCode = countries.alpha3ToAlpha2(String(loc.country || '').toUpperCase()) || require('../locationTextRules').normalizeCountryCode(loc.country);
  const countryName = countryCode ? countries.getName(countryCode, 'en') : loc.country;
  const locationRaw = [loc.city, loc.state, countryName].filter(Boolean).join(", ") || loc.locationDisplayName || loc.name || "";

  return {
    source_job_id: String(raw.jobId),
    employer_id: employer.id,
    source_type: "paylocity",
    source_url: jobUrl,
    application_url: raw.applyUrl || jobUrl,
    title_original: raw.title || "",
    company_name: employer.company_name,
    description_html: raw.description || null,
    description_text: (raw.description || raw.title || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    location_raw: locationRaw,
    location_evidence: { source_country_code: countryCode || null },
    compensation_text: raw.salaryDescription || null,
    date_posted: raw.publishedDate || raw.createdUtc || null,
    status: "active",
    source_verified: true,
  };
}

module.exports = { fetchPaylocityJobs, normalizePaylocityJob, parseBoardData };
