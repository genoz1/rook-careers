'use strict';

const { hash, cleanText } = require('./normalize');

const EVENT_RULES = [
  ['recall', /\brecall(?:s|ed|ing)?|market withdrawal|remove(?:s|d)? from the market\b/i, 'all'],
  ['acquisition-merger', /\b(?:acqui(?:re|res|red|sition)|merger|takeover|buyout|to buy|buys?|purchases?|take(?:s)? .{0,70} private|rolls? up|offloads?|sells?|sale of|divests?|term sheet.{0,80}acquisition)\b/i, 'headline'],
  ['separation-ipo-spinout', /\b(?:IPO|initial public offering|prices? (?:its )?IPO|spin[- ]?out|spins? (?:out|off)|separat(?:e|es|ion)|carve[- ]?out|begins? trading|public listing)\b/i, 'headline'],
  ['layoffs-restructuring', /\b(?:announces? layoffs?|lays? off|job cuts?|cuts? \d[\d,]* .{0,35}(?:jobs?|employees?)|workforce (?:cuts?|reduction)|reduces? (?:its )?workforce|restructur(?:e|es|ing)|eliminat(?:e|es|ing) \d[\d,]* roles?)\b/i, 'headline'],
  ['facility-manufacturing-investment', /\b(?:(?:invests?|investment|expansion).{0,80}(?:facility|plant|manufactur|production|site)|(?:expands?|opens?|builds?) .{0,60}(?:facility|plant|manufactur|production site))\b/i, 'headline'],
  ['funding', /\b(?:funding round|financing round|series [a-z]|raises? \$|venture round|investment round|secures? \$[\d,.]+(?:m|b| million| billion)? (?:in )?(?:funding|financing)|closes? \$[\d,.]+(?:m|b| million| billion)? (?:funding|financing)|awards? \$[\d,.]+(?:m|b| million| billion)?)\b/i, 'headline'],
  ['partnership', /\b(?:licens(?:e|es|ed|ing)|pact|alliance|collaboration|collab|partners? (?:with|on|to)|teams? (?:up )?with|signs? .{0,50}(?:deal|agreement) with|inks? .{0,50}(?:deal|pact|agreement) with|forges? .{0,50}(?:deal|alliance|partnership)|rights? (?:deal|agreement))\b/i, 'headline'],
  ['regulatory-designation', /\b(?:FDA\b.{0,100})?(?:breakthrough (?:device )?(?:designation|status)|orphan drug designation|priority review|fast track designation|IND clearance)\b/i, 'all'],
  ['international-regulatory-approval', /\b(?:CE mark|CE marked|European Commission approv|MHRA approv|TGA (?:approv|register)|Health Canada approv)\b/i, 'headline'],
  ['fda-approval-clearance', /\b(?:FDA (?:approves?|approved|clears?|cleared|authori[sz]es?|authori[sz]ed|greenlights?|greenlit)|(?:receives?|received|wins?|won|secures?|secured|lands?|landed|earns?|earned|gets?|got).{0,80}FDA (?:approval|approvals|clearance|clearances|authorization|nod)|granted (?:FDA )?(?:approval|clearance|authorization)|FDA nod for|510\(k\) clearance|premarket approval|PMA approval)\b/i, 'headline'],
  ['regulatory-designation', /\b(?:FDA\b.{0,100})?breakthrough (?:device )?(?:designation|status)\b/i, 'all'],
  ['regulatory-safety', /\b(?:safety communication|warning letter|enforcement action|clinical hold|FDA warns?|FDA warning|early alert|import alert)\b/i, 'all'],
  ['reimbursement-coverage', /\breimbursement|commercial coverage|Medicare coverage|Medicaid coverage|expands? .{0,35}coverage|coverage (?:policy|expansion|nod)|CPT(?:®)? codes?|billing codes?|health insurance drug list|formulary\b/i, 'headline'],
  ['contract-market-access', /\bmajor contract|government contract|health system contract|market access|medical centers?.{0,60}(?:agreement|partnership|access)|expands? access|awards? .{0,50}(?:contract|grant)\b/i, 'headline'],
  ['distribution-commercial-agreement', /\bdistribution agreement|commercial agreement|licensing agreement|exclusive distributor\b/i, 'headline'],
  ['commercial-expansion', /\bcommercial expansion|expand(?:s|ed)? (?:operations|commercial|sales|availability)|extends? availability|new facility|opens? (?:a )?(?:facility|office)|market entry|ramps? up .{0,30}(?:presence|operations)\b/i, 'headline'],
  ['product-launch', /\blaunch(?:es|ed)?|debut(?:s|ed)?|introduc(?:e|es|ed)|unveil(?:s|ed)?|commercial availability|new product\b/i, 'headline'],
  ['executive-sales-leadership', /\b(?:appoint(?:s|ed)?|names?|hires?|adds?|promotes?)\b.{0,100}\b(?:chief (?:commercial|veterinary|medical|executive|operating|business development) officer|commercial officer|head of sales|sales leader|vice president of sales|VP of sales|commercial president|global president|business development officer)\b/i, 'headline'],
  ['earnings-business-update', /\bearnings|quarterly results|financial results|revenue guidance|business update\b/i, 'headline'],
];

const NON_PRODUCT_LAUNCH = /\blaunch(?:es|ed)?\s+(?:the\s+)?.{0,40}\b(?:board|initiative|program|campaign|event|report|podcast|website)\b/i;
const PRELIMINARY_REGULATORY = /\b(?:nears?|seeks?|seeking|expects?|could receive|pending|recommended?|recommends?|files?|filed|submits?|submitted).{0,80}(?:FDA )?(?:approval|clearance|authorization)|(?:pre-?submission|NDA submission|files? for (?:approval|clearance)|filed for (?:approval|clearance)|panel (?:recommendation|vote|approval)|advisory committee recommendation|trial results?|study results?)\b/i;

const KNOWN_ENTITIES = [
  'Abbott', 'AbbVie', 'Bayer', 'Becton Dickinson', 'BD', 'Boston Scientific', 'Danaher', 'Dentsply Sirona',
  'Eli Lilly', 'GE HealthCare', 'IDEXX', 'Johnson & Johnson', 'Labcorp', 'Medtronic', 'Merck', 'Novartis',
  'Pfizer', 'Roche', 'Siemens Healthineers', 'Stryker', 'Thermo Fisher Scientific', 'Zoetis',
  'Edwards Lifesciences', 'Edwards', 'Abogen', 'Regeneron', 'Sanofi', 'Neptune Medical', 'Guardant Health',
  'Grail', 'Intuitive', 'Novo Nordisk', 'Eli Lilly', 'AstraZeneca', 'Daiichi Sankyo',
];

const STOPWORDS = new Set('a an and announces announcement at by for from in into is its new of on the to with will read more first company companies medical healthcare health news update updates'.split(' '));
const EVENT_STOPWORDS = new Set('fda approve approval approved approves clear clearance cleared clears greenlight greenlights nod deal deals pact agreement acquire acquisition merger launch launches launched partnership partners funding financing regulatory'.split(' '));
const TOKEN_SYNONYMS = new Map([
  ['acquisition', 'acquire'], ['acquires', 'acquire'], ['acquired', 'acquire'], ['buy', 'acquire'], ['buys', 'acquire'], ['takeover', 'acquire'],
  ['launches', 'launch'], ['launched', 'launch'], ['introduces', 'launch'], ['unveils', 'launch'],
  ['approval', 'approve'], ['approved', 'approve'], ['clearance', 'clear'], ['cleared', 'clear'],
  ['paediatric', 'pediatric'], ['kids', 'pediatric'], ['children', 'pediatric'], ['child', 'pediatric'],
  ['patients', 'patient'], ['valves', 'valve'], ['devices', 'device'], ['systems', 'system'],
]);
const DISTINCTIVE_PRODUCT_TOKENS = new Set('valve catheter stent balloon robot assay test implant pump pacemaker software platform therapy drug vaccine pediatric pulmonary mitral aortic colorectal cancer'.split(' '));

function classifyEventType(item) {
  const headline = String(item.title || '');
  const allText = `${headline} ${item.summary || ''}`;
  if (PRELIMINARY_REGULATORY.test(headline)) return 'regulatory-review-stage';
  for (const [type, rule, scope] of EVENT_RULES) {
    if (type === 'product-launch' && NON_PRODUCT_LAUNCH.test(headline)) continue;
    if (rule.test(scope === 'all' ? allText : headline)) return type;
  }
  return 'unknown';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractEntities(item) {
  const text = cleanText(`${item.title} ${item.summary}`);
  const known = KNOWN_ENTITIES.filter(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  const suffixed = [...text.matchAll(/\b([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,4}\s+(?:Inc\.?|Corp\.?|Corporation|LLC|Ltd\.?|plc|Pharmaceuticals|Therapeutics|Biotech|Diagnostics|Laboratories|Labs|Medical|Health))\b/g)].map(match => match[1]);
  const leadingActor = item.title.match(/^(.{2,70}?)\s+(?:to\s+)?(?:acquires?|buys?|sells?|launches?|introduces?|unveils?|appoints?|names?|partners?|merges?|inks?|pens?|signs?|forges?|raises?|secures?)\b/i)?.[1];
  const counterparties = [...item.title.matchAll(/\b(?:with|from|buys?|acquires?|acquisition of|merger with|sells? to)\s+([A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3})/g)].map(match => match[1]);
  return unique([...known, ...suffixed, ...counterparties, leadingActor && cleanText(leadingActor)])
    .map(value => value.replace(/\s+/g, ' ').trim()).filter(value => value.length > 1).slice(0, 10);
}

function extractProducts(item) {
  const matches = [...item.title.matchAll(/\b(?:launches?|introduces?|unveils?)\s+(?:the\s+)?([A-Z][A-Za-z0-9®™+.-]*(?:\s+[A-Z0-9][A-Za-z0-9®™+.-]*){0,4})/g)];
  return unique(matches.map(match => match[1])).slice(0, 5);
}

function extractIdentifiers(item) {
  const text = `${item.title} ${item.summary}`;
  return unique([
    ...[...text.matchAll(/\bK\d{6}\b/gi)].map(match => match[0].toUpperCase()),
    ...[...text.matchAll(/\bP\d{6}\b/gi)].map(match => match[0].toUpperCase()),
    ...[...text.matchAll(/\bNCT\d{8}\b/gi)].map(match => match[0].toUpperCase()),
  ]);
}

function headlineTokens(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map(token => TOKEN_SYNONYMS.get(token) || token)
    .filter(token => token.length > 2 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

function headlineSimilarity(a, b) {
  const left = new Set(headlineTokens(a));
  const right = new Set(headlineTokens(b));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter(token => right.has(token)).length;
  return intersection / new Set([...left, ...right]).size;
}

function materialTokens(value) {
  return headlineTokens(value).filter(token => !EVENT_STOPWORDS.has(token));
}

function distinctiveProductTokens(value) {
  const tokens = materialTokens(value).filter(token => DISTINCTIVE_PRODUCT_TOKENS.has(token));
  if (/\b(?:valve|implant)\b.{0,60}\b(?:grows? (?:up )?with|growing (?:kids?|children|patients?))\b|\b(?:grows? (?:up )?with|growing (?:kids?|children|patients?))\b.{0,60}\b(?:valve|implant)\b/i.test(value)) tokens.push('pediatric');
  return unique(tokens);
}

function dayDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
}

function overlap(a, b) {
  const right = new Set(b.map(value => value.toLowerCase()));
  return a.filter(value => right.has(value.toLowerCase())).length;
}

function decorate(item) {
  return {
    ...item,
    eventType: item.eventType || classifyEventType(item),
    entities: item.entities || extractEntities(item),
    products: item.products || extractProducts(item),
    identifiers: item.identifiers || extractIdentifiers(item),
  };
}

function sameEvent(a, b) {
  if (a.canonicalUrl && b.canonicalUrl && a.canonicalUrl === b.canonicalUrl) return true;
  if (a.retrievalHash && a.retrievalHash === b.retrievalHash) return true;
  if (a.eventType === 'unknown' || a.eventType !== b.eventType) return false;
  const identifiers = overlap(a.identifiers, b.identifiers);
  if (identifiers > 0) return true;
  if (dayDistance(a.publishedAt || a.firstSeenAt, b.publishedAt || b.firstSeenAt) > 3) return false;
  const entities = overlap(a.entities, b.entities);
  const similarity = headlineSimilarity(a.title, b.title);
  const materialOverlap = overlap(materialTokens(a.title), materialTokens(b.title));
  const productOverlap = overlap(distinctiveProductTokens(a.title), distinctiveProductTokens(b.title));
  return similarity >= 0.68 || entities >= 2 && similarity >= 0.2 || entities >= 1 && materialOverlap >= 2 || productOverlap >= 2;
}

function buildCluster(item) {
  const date = (item.publishedAt || item.firstSeenAt || '').slice(0, 10);
  return {
    clusterKey: hash([item.eventType, date, ...item.entities.map(value => value.toLowerCase()).sort(), ...headlineTokens(item.title).slice(0, 8)].join('|')),
    representativeTitle: item.title,
    category: item.categories?.[0] || item.sourceCategories?.[0] || 'medical-device',
    categories: unique(item.categories || item.sourceCategories || []),
    eventType: item.eventType,
    entities: [...item.entities],
    products: [...item.products],
    identifiers: [...item.identifiers],
    relevanceStatus: item.relevanceStatus,
    relevanceReason: item.relevanceReason,
    hasAuthoritativeEvidence: item.authorityTier === 1 || item.sourceKind === 'official',
    earliestPublicationAt: item.publishedAt || item.firstSeenAt,
    latestPublicationAt: item.publishedAt || item.firstSeenAt,
    items: [item],
  };
}

function addToCluster(cluster, item) {
  cluster.items.push(item);
  cluster.categories = unique([...cluster.categories, ...(item.categories || [])]);
  cluster.entities = unique([...cluster.entities, ...item.entities]);
  cluster.products = unique([...cluster.products, ...item.products]);
  cluster.identifiers = unique([...cluster.identifiers, ...item.identifiers]);
  cluster.hasAuthoritativeEvidence ||= item.authorityTier === 1 || item.sourceKind === 'official';
  cluster.earliestPublicationAt = [cluster.earliestPublicationAt, item.publishedAt].filter(Boolean).sort()[0] || null;
  cluster.latestPublicationAt = [cluster.latestPublicationAt, item.publishedAt].filter(Boolean).sort().at(-1) || null;
  if (item.relevanceStatus === 'relevant') cluster.relevanceStatus = 'relevant';
}

function clusterItems(items) {
  const clusters = [];
  for (const raw of items) {
    const item = decorate(raw);
    const cluster = clusters.find(candidate => candidate.items.some(existing => sameEvent(existing, item)));
    if (cluster) addToCluster(cluster, item);
    else clusters.push(buildCluster(item));
  }
  return clusters;
}

module.exports = {
  EVENT_RULES, classifyEventType, extractEntities, extractProducts, extractIdentifiers,
  PRELIMINARY_REGULATORY, headlineTokens, headlineSimilarity, materialTokens, distinctiveProductTokens,
  sameEvent, decorate, clusterItems,
};
