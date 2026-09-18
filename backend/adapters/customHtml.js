// Deterministic first-party careers ingestion. Never infer one job from a whole
// careers page. Evidence is separate from source verification and listing status.
const cheerio = require('cheerio');
const { createHash } = require('node:crypto');
const { resolveUsStateCode } = require('../jobEligibility');
const clean = value => String(value || '').replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const text = html => clean(cheerio.load(String(html || '')).text());
const canonical = value => { const u = new URL(value); u.hash = ''; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k); return u.href.replace(/\/$/, ''); };
function destination(value, base) {
  try { const u = new URL(value, base); return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
function titleOf($, node) {
  const explicit = $(node).find('.job-title, [itemprop="title"]').first();
  const label = explicit.length ? explicit.text() : $(node).text();
  return clean(label).replace(/^Accepting Applications\s*/i, '').replace(/\s+Proficiency in Both.*$/i, '');
}
function roleTitle(value) {
  return value.length > 4 && value.length < 150 && !/^(reports? to|position:|responsibilities|qualifications|about|meet|our |we |who |skills|daily|interested|please|apply|submit)/i.test(value) && /\b(manager|representative|specialist|consultant|liaison|technician|chemist|engineer|director|executive|associate|scientist|coordinator)\b/i.test(value);
}
function classify(body, { validThrough, datePosted, now = new Date(), structured = false } = {}) {
  const s = text(body);
  if (validThrough && Number.isFinite(Date.parse(validThrough)) && Date.parse(validThrough) < +now) return 'closed';
  if (/\b(position|role|vacancy)\s+(?:is |has been )?(?:closed|filled)|no longer accepting|applications? (?:are )?closed/i.test(s)) return 'closed';
  if (/future opportunit|future opening|talent (?:pool|community)|expression of interest/i.test(s)) return 'future';
  if (/no (?:current |open |available )?(?:positions|vacancies|openings)|not (?:currently )?hiring/i.test(s)) return 'closed';
  if (datePosted && Date.parse(datePosted) > +now) return 'future';
  if (/currently (?:accepting|hiring|recruiting|seeking)|accepting applications|now hiring/i.test(s)) return 'current';
  if (structured || /\bapply\b|submit (?:your |a )?(?:resume|application)|send (?:your |a )?(?:resume|cv)/i.test(s)) return 'likely_current';
  return 'unknown';
}
function applications($, fragment, url) {
  const links = [];
  $(fragment).find('a[href]').each((_, a) => {
    const href = destination($(a).attr('href'), url);
    if (href && (/apply|application|resume|indeed|linkedin/i.test($(a).text()) || href.startsWith('mailto:'))) links.push(href);
  });
  return [...new Set(links)];
}
function locations($, fragment, title) {
  const result = [];
  $(fragment).find('ul, ol').each((_, list) => {
    // Lists only supply territories when their immediately preceding text says
    // so. Do not mistake benefits, qualifications or headquarters for locations.
    const previous = clean($(list).prev().text());
    if (/following territor|available territor|locations?:?$/i.test(previous)) $(list).children('li').each((_, li) => result.push(clean($(li).text())));
  });
  $(fragment).find('[itemprop="jobLocation"], .job-location, .job-tag').each((_, el) => {
    const label = clean($(el).text());
    if (/field.based|remote|\b[A-Z]{2}\b|,/i.test(label) && !/full.time|part.time/i.test(label)) result.push(label);
  });
  $(fragment).find('p, dd, .job-location').each((_, el) => {
    const value = clean($(el).text());
    const match = value.match(/^(?:Job Location|Location|Territory)\s*:\s*(.{2,120})$/i);
    if (match) result.push(match[1]);
  });
  const body = $(fragment).text();
  const labeled = body.match(/(?:^|\n)\s*(?:Job Location|Location|Territory)\s*:\s*([^\n]{2,140})/i);
  if (labeled) result.push(clean(labeled[1]));
  const remote = title.match(/:\s*(Remote\s*\(US\))$/i);
  if (remote) result.push(remote[1]);
  return [...new Set(result.filter(Boolean))];
}
function structuredJobs($, url, now) {
  const records = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if ([].concat(value['@type'] || []).includes('JobPosting')) records.push(value);
    else for (const item of Object.values(value)) if (typeof item === 'object') Array.isArray(item) ? item.forEach(walk) : walk(item);
  }
  $('script[type="application/ld+json"]').each((_, el) => { try { walk(JSON.parse($(el).html())); } catch { /* Other tiers can still extract visible sections. */ } });
  return records.filter(j => clean(j.title)).map(j => {
    const locs = [].concat(j.jobLocation || []).map(l => l.address || l).map(a => clean([a.addressLocality, a.addressRegion, typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry?.name].filter(Boolean).join(', '))).filter(Boolean);
    if (j.jobLocationType === 'TELECOMMUTE') for (const area of [].concat(j.applicantLocationRequirements || [])) if (area.name) locs.push(`Remote, ${area.name}`);
    const body = j.description || '';
    const source = destination(j.url, url) || url;
    return { title: clean(j.title), html: body, url, locations: locs, tier: 'json_ld', confidence: 'high', status: body ? classify(body, {validThrough:j.validThrough, datePosted:j.datePosted, now, structured:true}) : 'unknown', applications:[source], identifier:clean(j.identifier?.value || (typeof j.identifier === 'string' ? j.identifier : '') || (canonical(source) !== canonical(url) ? canonical(source) : '')), datePosted:j.datePosted || null, validThrough:j.validThrough || null };
  });
}
function headingContext($, target, rank = 7) {
  const stack = [];
  $('h1,h2,h3,h4,h5,h6,details,.accordion-item,p').each((_, el) => {
    if (el === target) return false;
    if (!/^h[1-6]$/.test(el.tagName) || $(el).parents('details,.accordion-item').length) return;
    const level = Number(el.tagName[1]);
    while (stack.length && stack[stack.length-1].level >= level) stack.pop();
    stack.push({level, label:titleOf($,el)});
  });
  return stack.filter(h=>h.level < rank && !roleTitle(h.label)).map(h=>h.label).join(' ');
}
function parseCareersPage(html, url, { now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const jobs = structuredJobs($, url, now);
  $('script, style, nav, header, footer, noscript, template, [hidden], [aria-hidden="true"]').remove();
  const root = $('main').first().length ? $('main').first() : $('body');
  const pageText = clean(root.text());
  const details = [];
  root.find('details, .accordion-item').each((_, el) => {
    const title = titleOf($, $(el).find('summary, .accordion-item__title').first());
    if (!roleTitle(title)) return;
    const body = $.html(el);
    details.push({ title, html:body, url, locations:locations($, el, title), tier:'static_section', confidence:'high', status:classify(headingContext($,el) + ' ' + body,{now}), applications:applications($,el,url), identifier:$(el).attr('id') || '' });
    $(el).remove();
  });
  jobs.push(...details);
  // Work on serialized DOM offsets: a section may span several sibling CMS
  // blocks, so parent.text() is not a safe boundary (Wix is a common example).
  const content = root.html() || '';
  const doc = cheerio.load(content, { sourceCodeLocationInfo:true });
  const candidates = [];
  doc('h1,h2,h3,h4,h5,h6,summary,p').each((_, el) => {
    const title = titleOf(doc, el);
    if (!roleTitle(title) || doc(el).parents('li').length) return;
    if (el.tagName === 'p' && /[.!?]|\b(is|will|must|should|represents|responsibilities|reports)\b/i.test(title)) return;
    const offset = el.sourceCodeLocation?.startOffset;
    if (offset != null) candidates.push({el, title, offset, rank:/^h/.test(el.tagName) ? Number(el.tagName[1]) : 6});
  });
  const detailLinks = new Map();
  doc('a[href]').each((_, a) => {
    const label = clean(doc(a).text());
    const href = destination(doc(a).attr('href'), url);
    if (!href || !/^https?:/.test(href) || canonical(href) === canonical(url) || new URL(href).hostname !== new URL(url).hostname) return;
    if (roleTitle(label) || /^(apply here|view (?:job|position)|job details|learn more)$/i.test(label)) detailLinks.set(canonical(href), {url:href, title:roleTitle(label) ? label : null});
  });
  for (let i=0;i<candidates.length;i++) {
    const candidate = candidates[i];
    let end = candidates[i+1]?.offset ?? content.length;
    doc('h1,h2,h3,h4,h5,h6').each((_, h) => {
      const offset = h.sourceCodeLocation?.startOffset;
      if (offset > candidate.offset && offset < end && Number(h.tagName[1]) <= candidate.rank) end = offset;
    });
    const body = content.slice(candidate.offset,end);
    const context = headingContext(doc,candidate.el,candidate.rank);
    const section = cheerio.load(body);
    const apps = applications(section,section.root(),url);
    // A teaser pointing to a distinct detail page is not another posting.
    if (apps.some(a => detailLinks.has(canonical(a.startsWith('mailto:') ? url : a)))) continue;
    jobs.push({ title:candidate.title, html:body, url, locations:locations(section,section.root(),candidate.title), tier:'static_section', confidence:'medium', status:classify(context + ' ' + body,{now}), applications:apps, identifier:doc(candidate.el).attr('id') || '' });
  }
  return {jobs, detailLinks:[...detailLinks.values()], contentHash:hash(pageText), emptyConfirmed:/no (?:current |open |available )?(?:positions|vacancies|openings)/i.test(pageText) && !jobs.length};
}
function verifiedSource(url, employer) {
  // Source onboarding supplies the official website/careers URL. An off-site
  // application never affects verification of the page that published the job.
  const host = value => { try { return new URL(value).hostname.replace(/^www\./,''); } catch { return null; } };
  const actual = host(url);
  return !!actual && [employer.company_website, employer.careers_url].some(value => host(value) === actual);
}
function territoryGroup(label) {
  const parts = label.replace(/^(?:(?:southern|northern|eastern|western|central|southeast|southwest|northeast|northwest)[ /-]*)+/i,'').split(/[,/]/).map(clean);
  const states = parts.map(resolveUsStateCode);
  return {label, scope:states.length && states.every(Boolean) ? 'state_or_region' : 'unspecified', states:[...new Set(states.filter(Boolean))]};
}
function normalizeCustomHtmlJob(raw, employer) {
  const verified = verifiedSource(raw.url,employer);
  const locs = [...new Set(raw.locations || [])];
  const groups = locs.map(territoryGroup);
  const cityParts = locs.length === 1 ? locs[0].split(',').map(clean) : [];
  const explicitCity = cityParts.length >= 2 && cityParts.length <= 3 && resolveUsStateCode(cityParts[1]) && (!cityParts[2] || /^(US|USA|United States)$/i.test(cityParts[2])) && !resolveUsStateCode(cityParts[0]) && !/^(remote|field|hybrid|onsite)$/i.test(cityParts[0]) ? cityParts[0] : null;
  const regional = groups.length > 0 && groups.every(g=>g.scope === 'state_or_region');
  const identity = raw.identifier || `${canonical(raw.url)}#${raw.title.toLowerCase()}`;
  const arrangement = text(raw.html).match(/Work setting:\s*(Remote(?:\/hybrid)?|Hybrid|Onsite|On-site)/i);
  const active = verified && ['current','likely_current'].includes(raw.status) && text(raw.html).length >= 100;
  return {
    employer_id:employer.id, source_job_id:`custom_html:${hash(identity).slice(0,24)}`,
    source_type:'custom_html', source_url:raw.url, application_url:raw.applications?.[0] || raw.url,
    title_original:raw.title, company_name:employer.company_name,
    city:explicitCity, industry:employer.industry || null,
    remote_status:arrangement ? (/hybrid/i.test(arrangement[1]) ? 'hybrid' : /remote/i.test(arrangement[1]) ? 'remote' : 'onsite') : null,
    description_html:raw.html, description_text:text(raw.html),
    location_raw:locs.join(' | '), territory:locs.length ? locs.join(' | ') : null,
    date_posted:raw.datePosted && Number.isFinite(Date.parse(raw.datePosted)) ? new Date(raw.datePosted).toISOString().slice(0,10) : null,
    expires_at:raw.validThrough && Number.isFinite(Date.parse(raw.validThrough)) ? new Date(raw.validThrough).toISOString() : null,
    source_verified:verified, status:active ? 'active' : 'closed',
    ...(regional ? {location_evidence:{source_country_code:'US'}} : {}),
    extraction_evidence:{version:1, tier:raw.tier, confidence:raw.confidence, posting_status:raw.status, territories:groups, location_scope:regional ? 'state_or_region' : 'unspecified', application_destinations:raw.applications || [], content_hash:hash(text(raw.html)), page_hash:raw.pageHash || null}
  };
}
async function fetchCustomHtmlJobs(employer, { fetchPage, now = new Date() } = {}) {
  const url = employer.careers_url || employer.ats_identifier || employer.source_url;
  if (!url || !verifiedSource(url,employer)) throw new Error('custom_html needs a verified official careers URL');
  const origin = new URL(url).origin;
  const read = fetchPage || (async target => {
    if (new URL(target).origin !== origin) throw new Error('Refusing off-site detail fetch');
    const res = await fetch(target,{signal:AbortSignal.timeout(20000), redirect:'manual', headers:{Accept:'text/html','User-Agent':'ROOK-Careers/1.0'}});
    if (!res.ok) throw new Error(`Careers fetch ${res.status}: ${target}`);
    const body = await res.text();
    if (body.length > 3000000) throw new Error('Careers page exceeds size limit');
    return body;
  });
  const first = parseCareersPage(await read(url),url,{now});
  const all = first.jobs.map(j=>({...j,pageHash:first.contentHash}));
  if (first.detailLinks.length > 30) throw new Error('Too many detail links; source needs review');
  for (const link of first.detailLinks) {
    // A failed detail fetch aborts the employer sync, preventing accidental
    // closure of existing jobs from a partial snapshot.
    const page = parseCareersPage(await read(link.url),link.url,{now});
    if (!page.jobs.length) throw new Error(`No bounded job section on ${link.url}`);
    all.push(...page.jobs.map(j=>({...j,tier:j.tier === 'json_ld' ? j.tier : 'job_link',pageHash:page.contentHash})));
  }
  if (!all.length && !first.emptyConfirmed) throw new Error('No recognizable jobs or explicit empty state; source needs review');
  const unique = new Map();
  for (const raw of all) {
    const titleKey = clean(raw.title).toLowerCase();
    const key = `${titleKey}|${[...raw.locations].sort().join('|').toLowerCase()}`;
    const overlap = [...unique.entries()].find(([,j]) => clean(j.title).toLowerCase() === titleKey && canonical(j.url) === canonical(raw.url) && (!j.locations.length || !raw.locations.length));
    const previousKey = unique.has(key) ? key : overlap?.[0];
    const previous = previousKey ? unique.get(previousKey) : null;
    if (!previous) { unique.set(key,raw); continue; }
    const preferred = previous.tier === 'json_ld' ? previous : raw;
    const other = preferred === previous ? raw : previous;
    // Visible closure/future text overrides stale structured markup.
    const negative = [previous.status,raw.status].find(s=>['closed','future'].includes(s));
    unique.set(previousKey,{...preferred, status:negative || preferred.status, locations:preferred.locations.length ? preferred.locations : other.locations});
  }
  // Same-title separate postings require an explicit ID or location identity.
  const rows = [...unique.values()];
  for (const raw of rows) if (!raw.identifier && rows.filter(j=>j.title.toLowerCase() === raw.title.toLowerCase()).length > 1) raw.identifier = `${canonical(raw.url)}#${raw.title.toLowerCase()}#${[...raw.locations].sort().join('|')}`;
  return rows;
}
module.exports = {parseCareersPage, fetchCustomHtmlJobs, normalizeCustomHtmlJob, classify, verifiedSource};
