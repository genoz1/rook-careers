// Geo-scoped job pool for live dashboard / explore scoring.
// Always uses a lat/lng bounding box when coordinates exist, then adds
// capped home-state text supplements (and optional remote) in parallel.
// Replaces the previous single OR that pulled nationwide pipe/custom_html
// rows — and the broad-pref path that skipped the box entirely.

const { readJobPool } = require('./jobPool');

const STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

function titleCaseState(name) {
  return String(name).replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveHomeStateParts(homeState) {
  if (!homeState) return { name: null, abbr: null };
  const raw = String(homeState).trim();
  if (!raw) return { name: null, abbr: null };
  const key = raw.toLowerCase();
  if (STATE_ABBR[key]) {
    return { name: titleCaseState(key), abbr: STATE_ABBR[key] };
  }
  if (/^[a-z]{2}$/i.test(raw)) {
    const abbr = raw.toUpperCase();
    const entry = Object.entries(STATE_ABBR).find(([, code]) => code === abbr);
    return { name: entry ? titleCaseState(entry[0]) : null, abbr };
  }
  return { name: raw, abbr: null };
}

/**
 * @param {object} opts
 * @param {() => any} opts.createQuery fresh supabase query builder (status/moderation/industry already applied)
 * @param {number} opts.lat
 * @param {number} opts.lng
 * @param {string|null} [opts.homeState]
 * @param {boolean} [opts.allowBroad] include capped remote/national-leaning supplement
 * @param {number} [opts.radiusMiles]
 * @param {typeof readJobPool} [opts.readPool]
 */
async function fetchGeoScopedJobPool({
  createQuery,
  lat,
  lng,
  homeState = null,
  allowBroad = false,
  radiusMiles = 300,
  readPool = readJobPool,
  maxStateName = 500,
  maxStateAbbr = 300,
  maxRemote = 300,
  maxNullFallback = 400,
} = {}) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return { data: null, error: { message: 'lat and lng are required for geo-scoped pool' } };
  }

  const latDelta = radiusMiles / 69;
  const lngDelta = radiusMiles / (69 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const { name, abbr } = resolveHomeStateParts(homeState);

  const queries = [
    readPool(
      createQuery()
        .gte('job_lat', lat - latDelta)
        .lte('job_lat', lat + latDelta)
        .gte('job_lng', lng - lngDelta)
        .lte('job_lng', lng + lngDelta)
    ),
  ];

  if (name) {
    queries.push(readPool(createQuery().ilike('location_raw', `%${name}%`), { maxAccepted: maxStateName }));
  }
  if (abbr) {
    // Separate ilike calls — commas inside a single .or() break PostgREST parsing.
    queries.push(readPool(createQuery().ilike('location_raw', `% ${abbr},%`), { maxAccepted: maxStateAbbr }));
    queries.push(readPool(createQuery().ilike('location_raw', `%| ${abbr}%`), { maxAccepted: maxStateAbbr }));
  }
  if (!name && !abbr) {
    queries.push(readPool(createQuery().is('job_lat', null), { maxAccepted: maxNullFallback }));
  }
  if (allowBroad) {
    queries.push(
      readPool(
        createQuery().or('remote_status.eq.remote,and(job_lat.is.null,location_raw.ilike.%Remote%)'),
        { maxAccepted: maxRemote }
      )
    );
  }

  const parts = await Promise.all(queries);
  for (const part of parts) {
    if (part.error) return { data: null, error: part.error };
  }

  const byId = new Map();
  for (const part of parts) {
    for (const row of part.data || []) byId.set(row.id, row);
  }
  return { data: [...byId.values()], error: null };
}

module.exports = {
  fetchGeoScopedJobPool,
  resolveHomeStateParts,
  STATE_ABBR,
};
