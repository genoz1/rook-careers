// Selection only: no network, writes, publishing, or scheduling.
const { cities } = require('./data/social-top100-cities-2025.json');
const { US_ELIGIBLE_STATE_CODES } = require('./jobEligibility');
const states = require('zipcodes').states.full;
const RECENT_SELECTIONS = 6; // three days at the existing twice-daily cadence

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\bst\b/g, 'saint').replace(/\bft\b/g, 'fort');
}
const aliases = new Map([
  ['new york city', 'new york'], ['nyc', 'new york'],
  ['nashville davidson', 'nashville'], ['nashville davidson metropolitan government balance', 'nashville'],
  ['louisville jefferson county', 'louisville'], ['louisville jefferson county metro government balance', 'louisville'],
  ['lexington fayette', 'lexington'], ['lexington fayette urban county', 'lexington'],
  ['urban honolulu', 'honolulu'], ['urban honolulu cdp', 'honolulu'],
  ['boise city', 'boise'], ['indianapolis city balance', 'indianapolis'],
]);
const canonicalCity = value => aliases.get(normalize(value)) || normalize(value);
const top100 = new Set(cities.map(c => `${canonicalCity(c.city)}|${c.state}`));
const stateLabels = Object.entries(states).flatMap(([name, code]) => [[normalize(name), code], [code.toLowerCase(), code]])
  .concat([['district of columbia', 'DC'], ['dc', 'DC']])
  .filter(([, code]) => US_ELIGIBLE_STATE_CODES.has(code))
  .sort((a, b) => b[0].length - a[0].length);
const regionStates = {
  Northeast: 'CT ME MA NH RI VT NJ NY PA',
  Midwest: 'IN IL MI OH WI IA KS MN MO NE ND SD',
  South: 'DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX',
  West: 'AZ CO ID MT NV NM UT WY AK CA HI OR WA',
};
const regionForState = state => Object.keys(regionStates).find(r => regionStates[r].split(' ').includes(state));

function cityLocations(job) {
  // Use an explicit city/state pair from the source, not a geocoder's city
  // for a nationwide/remote/statewide job. Metro areas do not imply city proper.
  const result = new Map();
  for (const segment of String(job.location_raw || '').split(/[|;\/\n]+/)) {
    const text = normalize(segment)
      .replace(/^(?:remote|hybrid|on site|onsite)\s+/, '')
      .replace(/\s+(?:remote|hybrid|on site|onsite)$/, '')
      .replace(/^(?:united states of america|united states|usa|us)\s+/, '')
      .replace(/\s+(?:united states of america|united states|usa|us)$/, '')
      .replace(/\s+\d{5}(?: \d{4})?$/, '');
    for (const [label, state] of [...stateLabels.filter(([label]) => text.endsWith(` ${label}`)),
      ...stateLabels.filter(([label]) => text.startsWith(`${label} `))]) {
      let city;
      if (text.endsWith(` ${label}`)) city = text.slice(0, -label.length - 1);
      else if (text.startsWith(`${label} `)) city = text.slice(label.length + 1);
      if (!city || /\b(remote|nationwide|national|statewide|united states|region|territory|area|metro)\b/.test(city)) continue;
      city = canonicalCity(city);
      const key = `${city}|${state}`;
      result.set(key, { key, city, state, top100: top100.has(key), region: regionForState(state) });
      break;
    }
  }
  return [...result.values()];
}

function rankForCityVariety(rankedJobs, {
  previouslyFeaturedJobIds = new Set(), recentHistory = [], historyJobs = new Map(), employerKey,
} = {}) {
  const employers = new Map(), cityCounts = new Map(), regions = new Map();
  const add = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
  for (const row of recentHistory.slice(0, RECENT_SELECTIONS)) {
    add(employers, row.employer_spacing_key);
    const locations = cityLocations(historyJobs.get(row.job_id) || {});
    for (const loc of locations) add(cityCounts, loc.key);
    for (const region of new Set(locations.map(l => l.region))) add(regions, region);
  }
  return rankedJobs.map((job, qualityOrder) => {
    const locations = cityLocations(job);
    const employerRepeats = employers.get(employerKey(job)) || 0;
    const cityRepeats = Math.max(0, ...locations.map(l => cityCounts.get(l.key) || 0));
    return {job, qualityOrder, used: previouslyFeaturedJobIds.has(job.id) ? 1 : 0,
      repeats: employerRepeats + cityRepeats,
      preferred: locations.some(l => l.top100) ? 1 : 0,
      regionRepeats: Math.max(0, ...locations.map(l => regions.get(l.region) || 0))};
  }).sort((a, b) => a.used - b.used || a.repeats - b.repeats || b.preferred - a.preferred ||
    a.regionRepeats - b.regionRepeats || a.qualityOrder - b.qualityOrder).map(s => s.job);
}

module.exports = { RECENT_SELECTIONS, cityLocations, rankForCityVariety };
