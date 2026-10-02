'use strict';

const CATEGORY_RULES = [
  ['medical-device', /\bmedical devices?|medtech|surgical (?:device|robot|system)|procedural devices?|medical tubing|implant|catheter|stent|prosthe(?:sis|tic)|capital equipment|pulmonary valve|replacement valve|drug[- ]coated balloon|ingestible medical device|blood pressure (?:health )?(?:monitor|system)|sleep apnea|hypoglossal nerve stimulation|Medtronic|Stryker|Boston Scientific|Intuitive Surgical\b/i],
  ['diagnostics-laboratory', /\bdiagnostic(?:s)?|laborator(?:y|ies)|medical test|blood test|DNA test|molecular test|pathology|assay|sequencing|clinical chemistry|point[- ]of[- ]care test\b/i],
  ['pharmaceutical-biotech', /\bpharmaceutical|pharma\b|biotech(?:nology)?|biopharma|therapeutic|drug candidate|drug list|medical cannabis|clinical trial\b/i],
  ['veterinary-animal-health', /\bveterinar(?:y|ian)|animal health|companion animal|livestock|equine|pet medicine\b/i],
  ['dental', /\bdental|dentistry|orthodont|oral health|dental practice|dental equipment\b/i],
  ['healthcare-technology', /\bhealth(?:care|tech)|digital health|health IT|telehealth|clinical software|electronic health record|EHR|remote patient monitoring|continuous monitoring|wearable health\b/i],
  ['fda-regulatory', /\bFDA\b|regulator(?:y|ies)|510\(k\)|premarket approval|PMA\b|clearance|authori[sz]ation|greenlights?|breakthrough (?:device )?(?:designation|status)|safety communication|warning letter\b/i],
  ['ma-funding', /\bacqui(?:re|res|red|sition)|merger|takeover|rolls? up|funding|financing|series [a-z]|raises? \$|venture capital|term sheet\b/i],
  ['product-launches', /\blaunch(?:es|ed)?|debut(?:s|ed)?|introduc(?:e|es|ed)|unveil(?:s|ed)?|commercial availability|new product\b/i],
  ['commercial-sales', /\bcommercial expansion|sales organization|sales force|chief commercial officer|commercial officer|head of sales|sales leadership|commercial leadership|commercial coverage|reimbursement|coverage policy|health insurance drug list|formulary|market access|major contract|distribution agreement\b/i],
];

const STRONG_EVENT = /\b(acqui(?:re|res|red|sition)|merger|takeover|buyout|buys?|sells?|sale of|rolls? up|funding|financing|raises? \$|IPO|spin[- ]?out|separation|FDA|510\(k\)|PMA|approv(?:al|es|ed)|clearance|authori[sz]ation|greenlights?|breakthrough (?:device )?(?:designation|status)|CE mark|recall|launch(?:es|ed)?|debut(?:s|ed)?|commercial expansion|commercial coverage|reimbursement|coverage policy|health insurance drug list|formulary|market access|major contract|partners? (?:with|on|to)|teams? with|partnership|licens(?:e|es|ed|ing)|pact|alliance|distribution agreement|appoint(?:s|ed)?|names? .{0,50}(?:chief|president|head of sales|vice president of sales)|layoffs?|job cuts?|cuts? \d+ (?:jobs?|employees?)|earnings)\b/i;
const LOW_VALUE = /\b(celebrity|horoscope|beauty tips?|wellness tips?|home remed(?:y|ies)|weight loss tips?|local crime|police blotter|arrested|murder|robbery)\b/i;
const CONSUMER_ADVICE = /\b(how to (?:sleep|lose weight|feel better|eat healthier)|best foods? for|symptoms you should never ignore|home workout|self[- ]care routine)\b/i;
const INVESTMENT_ONLY = /\b(stock market today|which\b.{0,60}\bstock (?:is )?(?:a )?better buy|stocks? to buy|buy point|price target|investment recommendation|filing says .{0,40} trades|Dow (?:skids|jumps|falls)|Nasdaq|sector outlook.{0,50}(?:value|surge)|valuations? (?:soar|rise|fall))\b/i;
const GENERIC_MARKET_REPORT = /\b(market (?:size|forecast|growth forecast)|market.{0,50}to reach.{0,60}by 20\d\d|CAGR|expected to (?:reach|showcase|grow).{0,60}(?:by 20\d\d|CAGR)|stable growth forecast)\b/i;
const NON_NEWS_CONTENT = /\b(podcast|commentary|opinion|thought leadership|emerging trends|making .{0,50}(?:a )?(?:continuous )?health journey|how .{0,50} (?:is|are) transforming|engineering[- ]first|guide to|explainer|AI.{0,50}(?:core asset|building new AI|future of AI|AI systems))\b/i;
const ACADEMIC_ONLY = /\b(students?|university|researchers?|study (?:finds|shows)|academic|prototype|proof[- ]of[- ]concept|could (?:power|help|enable)|project presented)\b/i;
const COMMUNITY_EVENT = /\b(charity|fundraiser|awareness (?:event|campaign)|pink ribbon|teddy bears?|community[- ]interest|participates? in .{0,60}(?:roundtable|media event|conference)|student competition|wins? \$[\d,]+)\b/i;
const NON_PRODUCT_LAUNCH = /\blaunch(?:es|ed)?\s+(?:the\s+)?.{0,60}\b(?:board|initiative|programme?|campaign|event|report|podcast|website|challenge)\b/i;
const GENERIC_PROFILE = /\b(?:what .{0,80} means for shareholders|what it means for .{0,30} stock|company profile|investor profile|growth-oriented private equity|defensive-growth PE|platform with .{0,50}(?:capital|partners)|journey to witness|makes? (?:its|their) pitch to the world)\b/i;
const WORKPLACE_ADVICE = /\b(?:openness and vulnerability|strengthen .{0,30} teams?|practice owners?|personal wealth|smart financing|career advice|leadership tips?|workplace advice)\b/i;
const STALE_RECAP = /\b(?:weekly|wrap[- ]?up|year in review|annual .{0,30} approvals report|approvals that reshaped|lineup of .{0,30} candidates|top \d+ .{0,40}(?:deals|stories)|the targeted pulse)\b/i;
const PAGE_INDEX = /^\s*(?:deals?|news|updates?|latest news)\s*$/i;
const BROAD_TREND = /\b(?:big pharma (?:turns|turning)|industry trend|sector trend|competitive landscape|future of|state of the market|surging .{0,20} sector)\b/i;
const SPECULATIVE_EVENT = /\b(?:will be (?:shown|presented|featured)|to be (?:shown|presented|featured)|expects? approval|could receive approval|pending approval)\b/i;
const FUNDING_COMMENTARY = /\b(?:funding (?:ecosystem|environment|landscape).{0,40}(?:lags?|challenges?|weak|needs?)|talent and know-how.{0,40}funding)\b/i;
const WORKFORCE_TREND = /\b(?:recruiters?.{0,80}layoffs?|layoffs? (?:remain|stay|stays|cool|slow|decline)|signs of recovery.{0,80}layoffs?)\b/i;
const EVENT_CATEGORIES = new Set(['fda-regulatory', 'ma-funding', 'product-launches', 'commercial-sales']);

function categorize(text, sourceCategories = []) {
  const matches = CATEGORY_RULES.filter(([, rule]) => rule.test(text)).map(([slug]) => slug);
  return [...new Set([...matches, ...sourceCategories.filter(slug => matches.includes(slug))])];
}

function evaluateRelevance(item) {
  const title = String(item.title || '');
  const text = `${title} ${item.summary || ''}`;
  const categories = categorize(text, item.sourceCategories);
  const industrySignals = categories.filter(slug => !EVENT_CATEGORIES.has(slug));
  const headlineEvent = STRONG_EVENT.test(title) && !NON_PRODUCT_LAUNCH.test(title);
  const concreteEvent = Boolean(item.eventType && item.eventType !== 'unknown') || headlineEvent;
  const hardNoise = INVESTMENT_ONLY.test(title) || GENERIC_MARKET_REPORT.test(title) || PAGE_INDEX.test(title)
    || SPECULATIVE_EVENT.test(title) || FUNDING_COMMENTARY.test(title) || WORKFORCE_TREND.test(title);
  const contextualNoise = LOW_VALUE.test(text) || CONSUMER_ADVICE.test(text) || NON_NEWS_CONTENT.test(title)
    || ACADEMIC_ONLY.test(title) || COMMUNITY_EVENT.test(title) || NON_PRODUCT_LAUNCH.test(title)
    || GENERIC_PROFILE.test(title) || WORKPLACE_ADVICE.test(title) || STALE_RECAP.test(title) || BROAD_TREND.test(title);

  if (hardNoise) {
    return { status: 'rejected', reason: 'Investment-only, stock-market, valuation, or generic market-forecast content without a discrete industry event.', categories };
  }
  if (contextualNoise) {
    return { status: 'rejected', reason: 'Academic, community, commentary, event-participation, or other low-value content without a concrete commercial/regulatory event.', categories };
  }
  if (industrySignals.length && concreteEvent) {
    return { status: 'relevant', reason: 'Contains both healthcare-industry and concrete business/regulatory event signals.', categories };
  }
  if (industrySignals.length) {
    return { status: 'review', reason: 'Healthcare-industry context is present, but no sufficiently concrete business or regulatory event was established.', categories };
  }
  if (concreteEvent) {
    return { status: 'review', reason: 'A concrete event signal is present, but healthcare-industry context needs human confirmation.', categories };
  }
  if (LOW_VALUE.test(text) || CONSUMER_ADVICE.test(text) || contextualNoise) {
    return { status: 'rejected', reason: 'Matches an explicit low-value or non-industry content pattern.', categories };
  }
  return { status: 'rejected', reason: 'No concrete healthcare-industry, commercial, or regulatory event signal was found.', categories };
}

module.exports = {
  CATEGORY_RULES, STRONG_EVENT, LOW_VALUE, CONSUMER_ADVICE, INVESTMENT_ONLY, GENERIC_MARKET_REPORT,
  NON_NEWS_CONTENT, ACADEMIC_ONLY, COMMUNITY_EVENT, NON_PRODUCT_LAUNCH, GENERIC_PROFILE,
  WORKPLACE_ADVICE, STALE_RECAP, PAGE_INDEX, BROAD_TREND, categorize, evaluateRelevance,
  SPECULATIVE_EVENT, FUNDING_COMMENTARY, WORKFORCE_TREND,
};
