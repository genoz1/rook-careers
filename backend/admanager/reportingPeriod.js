// Calendar periods in each advertising account's reporting timezone.
function calendarRange(period = 'today', timeZone = 'UTC', now = new Date()) {
  if (!['today', 'yesterday', '7d'].includes(period)) throw new Error('Invalid reporting period');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const day = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  const offset = period === 'yesterday' ? -1 : 0;
  const length = period === '7d' ? 7 : 1;
  const date = n => new Date(day.getTime() + n * 86400000).toISOString().slice(0, 10);
  return { since: date(offset - length + 1), until: date(offset), time_zone: timeZone };
}
module.exports = { calendarRange };
