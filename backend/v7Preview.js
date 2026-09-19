// Shared allowlisted dashboard projection; onboarding answers and flow are unchanged.
const preview = require('./pretrialProjection').project;
function answersToProfile(a) {
  const l = a?.location;
  if (!l || typeof l.lat !== 'number' || typeof l.lng !== 'number' || !Number.isFinite(l.lat) || !Number.isFinite(l.lng) || Math.abs(l.lat)>90 || Math.abs(l.lng)>180) throw new Error('Select a valid location.');
  if (!['diagnostics','pharmaceutical','medical device','veterinary','breaking in'].includes(String(a.industry || '').toLowerCase())) throw new Error('Select an industry.');
  if (!Number.isFinite(a.years) || a.years < 0 || a.years > 60) throw new Error('Select your experience.');
  if (!Array.isArray(a.territories) || !a.territories.length || a.territories.length>4 || a.territories.some(t => !['local','regional','national','remote'].includes(t))) throw new Error('Select a territory.');
  const short = v => typeof v === 'string' ? v.slice(0,150) : null;
  const attribution = {};
  for (const key of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content']) {
    const value = a.attribution?.[key];
    if (typeof value === 'string' && value.trim()) attribution[key] = value.trim().slice(0,200);
  }
  return {
    ...attribution,
    home_lat:l.lat, home_lng:l.lng, home_city:short(l.city), home_state:short(l.state || l.stateAbbr), home_zip:short(l.zip), home_location_label:short(l.label),
    desired_industries:[a.industry], total_sales_years:a.years,
    territory_size_preferences:a.territories, territory_size_preference:a.territories[0],
    work_style:a.territories.length === 1 && a.territories[0] === 'remote' ? 'remote' : 'field'
  };
}
module.exports = {preview, answersToProfile};
