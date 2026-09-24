const { nyWallClockToUtc } = require('./socialAutomation');
const { getEasternParts } = require('./socialScheduler');
// Preserve the four custom marketing times observed in the live Sept 23 queue.
const DAILY_SLOTS = [
  { slot: 'am', hour: 8, minute: 30, kind: 'featured' },
  { slot: 'marketing-1', hour: 10, minute: 0, kind: 'education' },
  { slot: 'marketing-2', hour: 13, minute: 0, kind: 'industry' },
  { slot: 'marketing-3', hour: 16, minute: 0, kind: 'value' },
  { slot: 'pm', hour: 16, minute: 30, kind: 'match' },
  { slot: 'marketing-4', hour: 19, minute: 0, kind: 'engagement' },
];
const INDUSTRIES = ['Medical Device', 'Diagnostics/Laboratory', 'Pharmaceutical', 'Veterinary/Animal Health'];
const PERSONAL_COPY_TOKEN = '__ROOK_PERSONAL_LINKEDIN_COPY__';
function futureSlots(now = new Date()) {
  const { dateStr } = getEasternParts(now), slots = [];
  // A real rolling 48-hour window, not two UTC dates. Avoid past/near-due posts.
  for (let day = 0; day <= 2; day++) {
    const date = new Date(`${dateStr}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + day);
    const nextDate = date.toISOString().slice(0, 10);
    for (const item of DAILY_SLOTS) {
      const dueAt = nyWallClockToUtc(nextDate, item.hour, item.minute);
      if (dueAt > new Date(now.getTime() + 5 * 60000) && dueAt <= new Date(now.getTime() + 48 * 3600000)) {
        slots.push({ ...item, dateStr: nextDate, dueAt, industry: INDUSTRIES[Math.floor(date.getTime() / 86400000) % INDUSTRIES.length] });
      }
    }
  }
  return slots.slice(0, 12);
}
function representedPost(posts, channelId, slot) {
  return posts.find(p => p.channelId === channelId && ['scheduled', 'sending', 'sent'].includes(p.status) &&
    Math.abs(new Date(p.dueAt).getTime() - slot.dueAt.getTime()) <= 60000);
}
function availableCapacity(posts, channelId, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw Error('Buffer capacity unavailable; refusing to guess');
  return Math.max(0, limit - posts.filter(p => p.channelId === channelId && ['scheduled', 'sending'].includes(p.status)).length);
}
// Gene receives one featured opportunity every day plus three selected
// second posts per week: two ROOK Match opportunities and one job-search
// education post. This is exactly ten posts in a complete seven-day week,
// never a mirror of the six-post company schedule.
function isPersonalLinkedinSlot(slot) {
  const weekday = new Date(`${slot.dateStr}T12:00:00Z`).getUTCDay();
  if (slot.slot === 'am') return true;
  if (slot.slot === 'pm' && (weekday === 1 || weekday === 4)) return true;
  return slot.slot === 'marketing-1' && weekday === 6;
}
function personalLinkedinSlot(slot) {
  return { ...slot, dueAt: new Date(slot.dueAt.getTime() + 45 * 60000) };
}
function regularPost(slot, platform, copy) {
  const url = new URL('https://rookcareers.com/');
  url.search = new URLSearchParams({ utm_source: platform, utm_medium: 'social', utm_campaign: 'organic', utm_content: slot.kind }).toString();
  const label = slot.kind === 'industry' ? `${slot.industry} career reflection` : {
    education: 'Your medical sales job search', value: 'Explore medical and veterinary sales roles on ROOK', engagement: 'A question for the medical sales community',
  }[slot.kind];
  return `${label}\n\n${copy[platform] || copy.text}\n\nExplore ROOK: ${url}`;
}
module.exports = { DAILY_SLOTS, PERSONAL_COPY_TOKEN, futureSlots, representedPost, availableCapacity, isPersonalLinkedinSlot, personalLinkedinSlot, regularPost };
