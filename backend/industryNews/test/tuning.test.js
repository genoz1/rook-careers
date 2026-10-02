'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { preparedItem } = require('../worker');
const { normalizeItem, publisherFromUrl } = require('../normalize');
const { clusterItems } = require('../cluster');

const source = {
  id: 'rss-app-diagnostics', name: 'Diagnostics / Laboratory', publisher: 'RSS.app',
  categories: ['diagnostics-laboratory'], authorityTier: 3, kind: 'aggregator', status: 'active',
};
const now = new Date('2026-10-02T14:00:00.000Z');
const prepare = (title, summary = '') => preparedItem({
  guid: title, url: `https://example.test/${encodeURIComponent(title)}`, title, summary,
  publishedAt: '2026-10-02T12:00:00Z', creator: 'Example Reporter',
}, source, now);

test('promotes concrete healthcare commercial and regulatory events', () => {
  const cases = [
    ['FDA greenlights Edwards expandable pulmonary valve for paediatric patients', 'fda-approval-clearance'],
    ['Leica Biosystems receives multiple digital pathology FDA clearances', 'fda-approval-clearance'],
    ['Medtronic drug-coated balloon gets FDA breakthrough status', 'regulatory-designation'],
    ['Siemens Healthineers partners with Truvian to advance blood test platform', 'partnership'],
    ['bioAffinity Technologies and Pictor partner on asthma diagnostics', 'partnership'],
    ['Lucid Diagnostics secures commercial coverage policy for its DNA test', 'reimbursement-coverage'],
    ['Profusa signs term sheet for acquisition of diagnostics company', 'acquisition-merger'],
    ['Inner Logic raises $11.5M for procedural devices', 'funding'],
    ['Paws and profits: VetEvolve names first chief veterinary officer', 'executive-sales-leadership'],
    ['Banner Capital rolls up three plastics makers into a medical device platform', 'acquisition-merger'],
    ['Hilo debuts a blood pressure health system', 'product-launch'],
    ['Health ministry expands its health insurance drug list', 'reimbursement-coverage'],
    ['New billing codes approved for a sleep apnea system', 'reimbursement-coverage'],
  ];
  for (const [title, eventType] of cases) {
    const item = prepare(title);
    assert.equal(item.relevanceStatus, 'relevant', title);
    assert.equal(item.eventType, eventType, title);
  }
});

test('rejects reusable noise patterns without exact-headline rules', () => {
  const titles = [
    'Stock Market Today: Dow skids while a politician reports trades',
    'Healthcare Company A vs Company B: Which stock is a better buy?',
    'Global diagnostics market expected to reach $25B at a 7% CAGR by 2034',
    'University students win $2,000 for medical device project',
    'Teddy bears with medical devices help normalize treatment for children',
    'How AI and machine learning are transforming healthcare insights',
    'Engineering-First Medical Tubing Design: a guide to manufacturability',
    'Podcast: Continuous monitoring and the future of metabolic health',
    'Co-Diagnostics participates in medical innovation roundtable media event',
    'Medical device experts launch Medtech Innovation Board',
    'The rise of consumer diagnostics and emerging trends',
    'DNA diagnostics market to reach $24.7B by 2034',
    'Making diagnostics a continuous health journey',
  ];
  for (const title of titles) assert.equal(prepare(title).relevanceStatus, 'rejected', title);
});

test('cross-category veterinary evidence overrides the discovery bucket', () => {
  const item = prepare('VetEvolve names first chief veterinary officer');
  assert.equal(item.relevanceStatus, 'relevant');
  assert.ok(item.categories.includes('veterinary-animal-health'));
  assert.equal(item.categories.includes('diagnostics-laboratory'), false);
});

test('publisher comes from the article domain while RSS.app creator remains a byline', () => {
  assert.equal(publisherFromUrl('https://www.medicaldevice-network.com/news/example'), 'Medical Device Network');
  const item = normalizeItem({
    guid: 'publisher-1', title: 'FDA clears a pulmonary valve', url: 'https://www.medicaldevice-network.com/news/example',
    creator: 'Ross Law', publishedAt: '2026-10-02T12:00:00Z',
  }, source, now);
  assert.equal(item.originalPublisher, 'Medical Device Network');
  assert.equal(item.authorByline, 'Ross Law');
  assert.equal(item.sourceName, 'Medical Device Network');
});

test('recognizes reusable commercial event patterns without headline allowlists', () => {
  const cases = [
    ['J&J sells Laminar medical device assets', 'medical device portfolio transaction', 'acquisition-merger'],
    ['KKR to take Integer medical device company private for $5.7B', '', 'acquisition-merger'],
    ['Novartis signs licensing deal with Abogen for biotech platform', '', 'partnership'],
    ['Oura prices its IPO for digital health expansion', '', 'separation-ipo-spinout'],
    ['Elanco completes $120 million expansion of its animal health biologics plant', '', 'facility-manufacturing-investment'],
    ['Zimmer proposes to cut 580 medical device jobs', '', 'layoffs-restructuring'],
    ['Intuitive surgical robot earns CE mark for new indication', '', 'international-regulatory-approval'],
    ['CMS expands Medicare coverage for diagnostic testing', '', 'reimbursement-coverage'],
    ['Animal health company appoints new chief commercial officer', '', 'executive-sales-leadership'],
  ];
  for (const [title, summary, eventType] of cases) {
    const item = prepare(title, summary);
    assert.equal(item.eventType, eventType, title);
    assert.equal(item.relevanceStatus, 'relevant', title);
    assert.equal(item.automationEligible, true, title);
  }
});

test('Review, stale, unknown, Cafepharma, and roundup items cannot automatically advance', () => {
  assert.equal(prepare('A journey through the diagnostics industry').automationEligible, false);
  const stale = preparedItem({ guid: 'stale', url: 'https://example.test/stale', title: 'FDA clears a diagnostic test',
    publishedAt: '2026-09-20T12:00:00Z' }, source, now, {});
  assert.equal(stale.relevanceStatus, 'relevant');
  assert.equal(stale.isFresh, false);
  assert.equal(stale.automationEligible, false);
  const roundup = prepare('Paws and profits: company names chief commercial officer, and more updates');
  assert.equal(roundup.isRoundup, true);
  assert.equal(roundup.automationEligible, false);
  const cafe = preparedItem({ guid: 'cafe', url: 'https://example.test/cafe', title: 'FDA clears a diagnostic test',
    publishedAt: '2026-10-02T12:00:00Z' }, { ...source, id: 'rss-app-cafepharma', automationPolicy: 'lead-only' }, now, {});
  assert.equal(cafe.automationEligible, false);
});

test('clusters same events across publishers but not unrelated events from one company', () => {
  const med = { ...source, categories: ['medical-device'] };
  const item = (guid, title, publisher) => preparedItem({ guid, url: `https://${publisher}.test/${guid}`, title,
    summary: 'medical device regulatory event', publishedAt: '2026-10-02T12:00:00Z', sourcePublisher: publisher }, med, now, {});
  const clusters = clusterItems([
    item('edwards-1', 'FDA greenlights Edwards expandable pulmonary valve for pediatric patients', 'Publisher One'),
    item('edwards-2', 'Edwards wins FDA approval for size-adjustable pediatric heart valve', 'Publisher Two'),
    item('edwards-3', 'Edwards reports FDA clearance for unrelated monitoring software', 'Publisher Three'),
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters.find(cluster => cluster.items.length === 2).items.length, 2);
});

test('distinguishes preliminary regulatory stages from completed FDA decisions', () => {
  const preliminary = [
    "Grail's cancer blood test nears landmark FDA approval, but insurance coverage looms",
    'Cancer blood test gets FDA panel recommendation for approval',
    'BioCardia files revised De Novo pre-submission for FDA approval of Helix catheter',
    'Medical test company prepares for VA centers pending FDA clearance',
  ];
  for (const title of preliminary) {
    const item = prepare(title, 'medical diagnostic product');
    assert.equal(item.eventType, 'regulatory-review-stage', title);
    assert.equal(item.automationEligible, false, title);
  }
  const final = prepare('Edwards receives FDA approval for expandable pediatric pulmonary valve', 'medical device');
  assert.equal(final.eventType, 'fda-approval-clearance');
  assert.equal(final.relevanceStatus, 'relevant');
  assert.equal(final.automationEligible, true);
});

test('blocks speculative events and funding or workforce trend commentary', () => {
  const titles = [
    'Replacement valve will be shown Sunday',
    'India has biotech talent and know-how, but funding ecosystem lags',
    'Biopharma recruiters see signs of recovery as layoffs remain cool',
  ];
  for (const title of titles) assert.equal(prepare(title, 'medical device pharmaceutical biotech').automationEligible, false, title);
  assert.equal(prepare('DeviceCo raises $80M financing round for a medical device').automationEligible, true);
  assert.equal(prepare('DeviceCo cuts 120 medical device jobs in restructuring').automationEligible, true);
});

test('clusters the actual Edwards pediatric-valve headline variants into one event', () => {
  const med = { ...source, categories: ['medical-device'] };
  const variants = [
    ['a', 'FDA greenlights Edwards’ expandable pulmonary valve for paediatric patients'],
    ['b', 'Edwards Lifesciences secures FDA approval for first expandable pediatric heart valve'],
    ['c', 'A Heart Valve That Grows Up With The Patient Wins FDA Approval'],
    ['d', 'Edwards wins FDA approval for pediatric, size-adjustable pulmonary valve'],
    ['e', 'FDA Approves Only Surgical Pulmonary Valve Fit for Growing Kids'],
  ].map(([guid,title],index)=>preparedItem({guid,url:`https://publisher-${index}.test/${guid}`,title,
    summary:index===2?'A size-adjustable surgical valve received completed FDA approval.':'Edwards Lifesciences announced the completed FDA approval for its pediatric pulmonary valve.',
    publishedAt:'2026-10-02T12:00:00Z',sourcePublisher:`Publisher ${index}`},med,now,{}));
  variants.push(preparedItem({guid:'other',url:'https://publisher-other.test/other',
    title:'Edwards receives FDA clearance for unrelated monitoring software',summary:'A different Edwards medical device product.',
    publishedAt:'2026-10-02T12:00:00Z',sourcePublisher:'Publisher Other'},med,now,{}));
  const clusters=clusterItems(variants);
  assert.equal(clusters.length,2);
  assert.equal(clusters.find(cluster=>cluster.items.length===5).items.length,5);
});
