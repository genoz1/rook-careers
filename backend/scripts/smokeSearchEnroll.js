#!/usr/bin/env node
// Smoke: search → official source resolve → validation path for a known company
// without purchasing paid search. Uses free HTML/Wikidata providers only.
require('dotenv').config();
const {
  searchOfficialCareerCandidates,
  resolveOfficialSource,
  createPublicSearchSession,
} = require('../discovery/sourceResolver');

async function main() {
  const company = process.argv[2] || 'Vetoquinol';
  const industry = process.argv[3] || 'animal health';
  const session = createPublicSearchSession();
  const search = await searchOfficialCareerCandidates(company, {
    industry,
    searchSession: session,
  });
  console.log('SEARCH_OK', JSON.stringify({
    company,
    count: search.length,
    providers: [...new Set(search.map((r) => r.provider))],
    top: search.slice(0, 3).map((r) => ({ url: r.url, provider: r.provider })),
    trace: search.trace,
  }, null, 2));

  const resolved = await resolveOfficialSource({
    company_name: company,
    industry,
  }, {
    searchCareers: (name, options) => searchOfficialCareerCandidates(name, { ...options, searchSession: session }),
  });
  console.log('RESOLVE_OK', JSON.stringify({
    official_domain: resolved.official_domain,
    configurations: (resolved.configurations || []).map((c) => ({
      ats_type: c.ats_type,
      ats_identifier: c.ats_identifier,
      source_url: c.source_url,
    })),
    selected_kind: resolved.evidence?.selected_candidate?.kind,
    search_trace: resolved.evidence?.search_provider_trace,
  }, null, 2));
}

main().catch((error) => {
  console.error('SMOKE_FAIL', error.code || '', error.message);
  if (error.evidence) console.error(JSON.stringify(error.evidence, null, 2));
  process.exitCode = 1;
});
