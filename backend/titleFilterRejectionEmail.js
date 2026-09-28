const { TABLE } = require('./titleFilterDiagnostics');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function easternParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function render(rows) {
  if (!rows.length) return '<h1>ROOK title-filter rejection summary</h1><p>No title-filter rejections were recorded in the last 24 hours.</p>';
  const items = rows.map(row => `<tr>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(row.company_name || 'Unknown employer')}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(row.title)}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(row.location || 'Not provided')}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(row.source_adapter || 'Unknown')}</td>
    <td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(row.source_job_id || 'Not provided')}</td>
  </tr>`).join('');
  return `<h1>ROOK title-filter rejection summary</h1>
    <p>${rows.length} job${rows.length === 1 ? '' : 's'} encountered during the last 24 hours were rejected by <code>titleLooksRelevant()</code>.</p>
    <table style="border-collapse:collapse;width:100%"><thead><tr>
      <th align="left" style="padding:8px;border-bottom:2px solid #999">Employer</th>
      <th align="left" style="padding:8px;border-bottom:2px solid #999">Title</th>
      <th align="left" style="padding:8px;border-bottom:2px solid #999">Location</th>
      <th align="left" style="padding:8px;border-bottom:2px solid #999">Source</th>
      <th align="left" style="padding:8px;border-bottom:2px solid #999">Job ID</th>
    </tr></thead><tbody>${items}</tbody></table>
    <p>Reason for every row: titleLooksRelevant returned false.</p>`;
}

async function sendDailyTitleFilterRejections(db, {
  now = new Date(), to, sendEmail, lastSentDate = null,
} = {}) {
  const eastern = easternParts(now);
  // A restart or brief outage during 8 AM must not silently skip the day.
  if (eastern.hour < 8 || eastern.date === lastSentDate) return { sent: false, date: lastSentDate };
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from(TABLE).select('company_name,title,location,source_adapter,source_job_id,rejected_at').gte('rejected_at', since).order('rejected_at', { ascending: false }).limit(500);
  if (error) throw new Error(`Cannot read title-filter rejections: ${error.message}`);
  const rows = data || [];
  await sendEmail({
    to,
    subject: rows.length ? `ROOK: ${rows.length} title-filter rejection${rows.length === 1 ? '' : 's'} to review` : 'ROOK: no title-filter rejections in the last 24 hours',
    html: render(rows),
    idempotencyKey: `title-filter-rejections-${eastern.date}`,
  });
  return { sent: true, date: eastern.date, count: rows.length };
}

module.exports = { easternParts, render, sendDailyTitleFilterRejections };
