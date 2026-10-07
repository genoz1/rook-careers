const { TARGET_EMPLOYERS } = require('../discoverEmployers');
const { normalizeCompanyName } = require('./pipeline');
const { safeOfficialWebsite, websiteFromPublicSignals } = require('./marketSignals');

const VMX_GALLERY_URL = 'https://vmx2027.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm?featured=false';
const VMX_SEARCH_URL = 'https://vmx2027.mapyourshow.com/8_0/ajax/remote-proxy.cfm?action=search&searchtype=exhibitorgallery&searchsize=500';
const VMX_DETAIL_URL = 'https://vmx2027.mapyourshow.com/8_0/exhibitor/exhibitor-details.cfm?exhid=';
const NON_COMMERCIAL = /\b(academy|association|college|university|school|foundation|charity|rescue|shelter|government|department of|board of veterinary|veterinary hospital|animal hospital|veterinary clinic|animal clinic)\b/i;
const COMMERCIAL_EVIDENCE = /\b(manufactur|diagnostic|pharma|therapeutic|medical|device|equipment|product|software|technology|solution|distribut|nutrition|laborator|service|insurance|finance|platform|supplier)\b/i;

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : String(response.headers.get('set-cookie') || '').split(/,(?=[^;,]+=)/);
  return values.map((value) => value.split(';')[0]).filter(Boolean).join('; ');
}

async function fetchVmxCompanies({ httpFetch = fetch } = {}) {
  const landing = await httpFetch(VMX_GALLERY_URL, { headers: { 'User-Agent': 'ROOK-Careers/1.0 (public company discovery; contact@rookcareers.com)' } });
  if (!landing.ok) throw new Error(`VMX directory returned ${landing.status}`);
  await landing.text();
  const cookies = cookieHeader(landing);
  const response = await httpFetch(VMX_SEARCH_URL, { headers: {
    Accept: 'application/json', Cookie: cookies, Referer: VMX_GALLERY_URL,
    'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'ROOK-Careers/1.0 (public company discovery; contact@rookcareers.com)',
  } });
  if (!response.ok) throw new Error(`VMX exhibitor search returned ${response.status}`);
  const payload = await response.json();
  if (!payload.SUCCESS) throw new Error(payload.ERRORMESSAGE || 'VMX exhibitor search failed');
  const companies = (payload.DATA?.results?.exhibitor?.hit || []).map((hit) => ({
    company_name: String(hit.fields?.exhname_t || '').replace(/\s+/g, ' ').trim(),
    description: String(hit.fields?.exhdesc_t || '').replace(/\s+/g, ' ').trim(),
    source_id: String(hit.fields?.exhid_l || ''), industry: 'animal health',
    signal_source: 'vmx-2027-official-directory', directory_url: `${VMX_DETAIL_URL}${hit.fields?.exhid_l || ''}`,
    source_cookie: cookies,
  })).filter((company) => company.company_name && !NON_COMMERCIAL.test(company.company_name) && COMMERCIAL_EVIDENCE.test(`${company.company_name} ${company.description}`));
  return { companies, total_listed: Number(payload.DATA?.totalhits || companies.length), cookies };
}

function decodeJsString(value) {
  try { return JSON.parse(`"${value.replace(/"/g, '\\"')}"`); } catch { return value.replace(/\\\//g, '/'); }
}

async function websiteFromVmxProfile(company, { httpFetch = fetch } = {}) {
  const response = await httpFetch(company.directory_url, { headers: {
    Cookie: company.source_cookie || '', Referer: VMX_GALLERY_URL,
    'User-Agent': 'ROOK-Careers/1.0 (public company discovery; contact@rookcareers.com)',
  } });
  if (!response.ok) throw new Error(`VMX exhibitor profile returned ${response.status}`);
  const html = await response.text();
  const encoded = html.match(/websiteValue:\s*"((?:\\.|[^"\\])*)"/)?.[1];
  const website = encoded ? safeOfficialWebsite(decodeJsString(encoded)) : null;
  return website ? { website, match: 'official_vmx_exhibitor_profile', directory_url: company.directory_url } : null;
}

function curatedIndustryCompanies() {
  return TARGET_EMPLOYERS.map(([company_name, industry]) => ({
    company_name, industry, signal_source: 'rook-industry-company-catalog',
    description: `Curated ${industry} company ecosystem candidate`,
  }));
}

function dedupeCompanies(companies) {
  const seen = new Set();
  return companies.filter((company) => {
    const key = normalizeCompanyName(company.company_name);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

async function discoverCompanyFirstSignals({
  knownEmployers = [], limit = 10, offset = 0, includeVmx = true, includeCurated = true,
  httpFetch = fetch, resolveWebsite = websiteFromPublicSignals,
} = {}) {
  let vmx = { companies: [], total_listed: 0 };
  let vmx_error = null;
  if (includeVmx) {
    try {
      vmx = await fetchVmxCompanies({ httpFetch });
    } catch (error) {
      vmx_error = error.message;
    }
  }
  const catalog = dedupeCompanies([...(includeVmx ? vmx.companies : []), ...(includeCurated ? curatedIndustryCompanies() : [])]);
  const known = new Set(knownEmployers.map((employer) => normalizeCompanyName(employer.company_name)));
  const existing = catalog.filter((company) => known.has(normalizeCompanyName(company.company_name)));
  const unknown = catalog.filter((company) => !known.has(normalizeCompanyName(company.company_name)));
  const selected = unknown.length
    ? Array.from({ length: Math.min(limit, unknown.length) }, (_, index) => unknown[(offset + index) % unknown.length])
    : [];
  const signals = [];
  const resolution_failures = [];
  for (const company of selected) {
    let evidence = null;
    try {
      if (company.signal_source.startsWith('vmx-')) evidence = await websiteFromVmxProfile(company, { httpFetch });
      if (!evidence) evidence = await resolveWebsite(company.company_name, { industry: company.industry, httpFetch });
    } catch (error) { resolution_failures.push({ company_name: company.company_name, reason: error.message }); }
    signals.push({
      company_name: company.company_name, company_website: evidence?.website || null,
      industry: company.industry, signal_source: company.signal_source,
      source_signal_id: company.source_id || normalizeCompanyName(company.company_name),
      source_evidence: { directory_url: company.directory_url || null, description: company.description || null, website_resolution: evidence },
    });
  }
  return { signals, stats: {
    vmx_total_listed: vmx.total_listed, vmx_error, catalog_companies: catalog.length,
    already_monitored: existing.length, genuinely_new: unknown.length,
    selected_for_controlled_run: selected.length,
    official_websites_resolved: signals.filter((signal) => signal.company_website).length,
    official_websites_unresolved: signals.filter((signal) => !signal.company_website).length,
    resolution_failures,
  } };
}

module.exports = {
  VMX_GALLERY_URL, VMX_SEARCH_URL, fetchVmxCompanies, websiteFromVmxProfile,
  curatedIndustryCompanies, dedupeCompanies, discoverCompanyFirstSignals,
};
