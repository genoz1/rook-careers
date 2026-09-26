// Collect only the small set of fields needed to audit shared title-filter
// rejections. The filter itself remains the sole authority on acceptance.
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { titleLooksRelevant } = require('./relevanceFilter');

const context = new AsyncLocalStorage();
const TABLE = 'ingestion_title_filter_rejections';
const RETENTION_DAYS = 30;
const clip = (value, length) => String(value ?? '').trim().slice(0, length) || null;

function scalarLocation(value) {
  if (typeof value === 'string' || typeof value === 'number') return clip(value, 300);
  if (Array.isArray(value)) return value.map(scalarLocation).filter(Boolean).slice(0, 8).join(' | ') || null;
  if (!value || typeof value !== 'object') return null;
  const parts = [];
  for (const key of ['formatted', 'formattedLocation', 'displayName', 'name', 'label', 'city', 'locality', 'state', 'region', 'country']) {
    if (value[key] != null) {
      const part = scalarLocation(value[key]);
      if (part && !parts.includes(part)) parts.push(part);
      if (parts.length >= 5) break;
    }
  }
  return parts.join(', ') || null;
}

function firstValue(job, keys) {
  for (const key of keys) {
    const value = job?.[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const clean = clip(value, 300);
      if (clean) return clean;
    }
  }
  return null;
}

function rejectionRecord(title, job = {}, employer = {}) {
  const location = firstValue(job, ['location_raw', 'location', 'Location', 'formattedLocation', 'locationName', 'cityState']) ||
    scalarLocation(job.locations || job.Locations || job.requisitionLocations || job.jobLocations);
  const sourceJobId = firstValue(job, ['source_job_id', 'sourceJobId', 'jobReqId', 'jobReqID', 'requisitionId', 'requisitionID', 'reqId', 'externalJobId', 'externalId', 'jobId', 'JobId', 'itemID', 'id', 'Id', 'externalPath', 'url', 'path']);
  const normalizedTitle = clip(title, 300) || '';
  const identity = [employer.id || '', employer.ats_type || '', sourceJobId || '', normalizedTitle.toLowerCase(), location || ''].join('\n');
  return {
    diagnostic_key: createHash('sha256').update(identity).digest('hex'),
    rejected_at: new Date().toISOString(),
    employer_id: employer.id || null,
    company_name: clip(job?.company?.display_name || job?.companyName || employer.company_name || employer.name, 160),
    source_adapter: clip(employer.ats_type, 50),
    source_job_id: sourceJobId,
    title: normalizedTitle,
    location,
    rejection_reason: 'titleLooksRelevant returned false',
  };
}

function withTitleFilterDiagnostics(employer, action) {
  return context.run({ employer, rejections: [] }, action);
}

function getTitleFilterRejections() {
  return context.getStore()?.rejections || [];
}

function titleLooksRelevantWithDiagnostics(title, job = {}) {
  const accepted = titleLooksRelevant(title);
  if (!accepted) {
    const active = context.getStore();
    if (active) active.rejections.push(rejectionRecord(title, job, active.employer));
  }
  return accepted;
}

async function persistTitleFilterRejections(db, rows, { batchSize = 500 } = {}) {
  if (!rows?.length) return 0;
  const uniqueRows = [...new Map(rows.map(row => [row.diagnostic_key, row])).values()];
  for (let offset = 0; offset < uniqueRows.length; offset += batchSize) {
    const { error } = await db.from(TABLE).upsert(uniqueRows.slice(offset, offset + batchSize), { onConflict: 'diagnostic_key' });
    if (error) throw new Error(`Could not persist title-filter diagnostics: ${error.message}`);
  }
  return uniqueRows.length;
}

async function pruneTitleFilterRejections(db, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await db.from(TABLE).delete().lt('rejected_at', cutoff);
  if (error) throw new Error(`Could not prune title-filter diagnostics: ${error.message}`);
}

module.exports = {
  TABLE,
  RETENTION_DAYS,
  rejectionRecord,
  withTitleFilterDiagnostics,
  getTitleFilterRejections,
  titleLooksRelevantWithDiagnostics,
  persistTitleFilterRejections,
  pruneTitleFilterRejections,
};
