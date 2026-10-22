'use strict';
// OFFLINE PILOT ONLY. No credentials, network clients, scheduler or production imports.
// Integration requires durable transactional storage and approved publisher adapters.
const { createHash } = require('node:crypto');
const { validateSnapshot } = require('../hiringIntelligence');
const ROOT = 'https://rookcareers.com';
const { guides } = require('../organicGuidance');
const guideReserve = [0, 1].flatMap(index => Object.entries(guides).map(([slug, guide]) => ({
  id: `${slug}-part-${index + 1}`, text: `${guide.title}: ${guide.paragraphs[index]}`, url: ROOT + '/resources/' + slug + '/',
})));
const evergreen = Object.freeze([
  { id: 'resume-evidence', text: 'Medical sales resume tip: explain the customer setting, your own action and an outcome you can substantiate. Keep confidential account details out of your examples.', url: ROOT + '/resources/how-to-write-a-medical-sales-resume/' },
  { id: 'interview-examples', text: 'Preparing for a medical sales interview? Build examples covering new business, an account challenge and a setback. Explain what you did and what you learned.', url: ROOT + '/resources/medical-sales-interview-questions-what-to-expect-and-how-to-prepare/' },
  { id: 'territory-plan', text: 'A useful territory plan separates known facts from assumptions. Explain the information you need, how you would prioritize accounts and how you would measure progress.', url: ROOT + '/resources/how-to-build-a-30-60-90-day-territory-sales-plan/' },
  ...guideReserve,
]);
const hash = value => createHash('sha256').update(value).digest('hex');
function freshReport(snapshot, now) {
  validateSnapshot(snapshot);
  const age = now - Date.parse(snapshot.capturedAt);
  if (age < 0 || age > 24 * 60 * 60 * 1000) throw Error('stale_or_future_snapshot');
  const c = snapshot.collections.find(c => c.path === '/jobs/category/medical-device-sales-jobs');
  if (!c || c.suppressed) throw Error('aggregate_unavailable');
  // Never interpolate labels, source text, employer names or individual job fields.
  return { id: 'device-snapshot-' + snapshot.capturedAt,
    text: `ROOK tracked ${c.jobs.toLocaleString('en-US')} opportunities in its medical device sales collection across ${c.representedEmployers.toLocaleString('en-US')} represented employers as of ${new Date(snapshot.capturedAt).toISOString().slice(0, 10)} (UTC). This is tracked inventory, not the entire employment market or a measure of hiring growth.`,
    url: ROOT + c.path };
}
function createPilot({ state, provider, checkDestination, allowedChannels, clock = Date.now }) {
  if (provider.mode !== 'simulation') throw Error('Only simulation adapters allowed');
  state.outbox ||= {}; state.history ||= []; state.events ||= [];
  const event = (slot, action, detail) => state.events.push({ slot, action, detail });
  async function runSlot({ slot, channel, snapshot, refreshSnapshot }) {
    if (!allowedChannels.includes(channel)) throw Error('Channel not allowlisted');
    const key = hash(channel + ':' + slot);
    let row = state.outbox[key];
    if (row?.status === 'published') return row;
    if (row?.status === 'uncertain') {
      // A timeout can follow a successful send. Never blindly repeat it.
      let receipt;
      try { receipt = await provider.reconcile(key); }
      catch { event(slot, 'reconciliation_retry_due'); return row; }
      if (receipt.status === 'published') {
        row.status = 'published'; row.receipt = receipt.id;
        state.history.push({ channel, hash: row.contentHash, at: clock() });
        event(slot, 'publication_reconciled'); return row;
      }
      if (receipt.status !== 'absent') return row;
      row.status = 'retry_due';
    }
    if (row?.retryAt > clock()) return row;
    if (!row) {
      const candidates = [];
      try { candidates.push(freshReport(snapshot, clock())); }
      catch (e) {
        event(slot, 'snapshot_rejected', e.message);
        if (refreshSnapshot) {
          try { candidates.push(freshReport(await refreshSnapshot(), clock())); event(slot, 'snapshot_repaired'); }
          catch { event(slot, 'refresh_failed_using_reserve'); }
        }
      }
      candidates.push(...evergreen);
      for (const candidate of candidates) {
        const contentHash = hash(candidate.text + candidate.url);
        if (state.history.some(h => h.channel === channel && h.hash === contentHash && clock() - h.at < 30 * 86400000) ||
            Object.values(state.outbox).some(r => r.channel === channel && r.contentHash === contentHash && r.status !== 'published')) continue;
        let valid = false;
        try { valid = await checkDestination(candidate.url); } catch { /* try another destination */ }
        if (!valid) { event(slot, 'destination_rejected', candidate.id); continue; }
        row = state.outbox[key] = { key, slot, channel, candidate, contentHash, status: 'ready', attempts: 0 };
        event(slot, candidates[0] === candidate && candidate.id.startsWith('device-snapshot-') ? 'fresh_selected' : 'reserve_selected', candidate.id);
        break;
      }
      if (!row) {
        // Backlog is explicit and retried; never silently mark this slot done.
        event(slot, 'reserve_replenishment_required');
        return { status: 'backlog', reason: 'No unused validated content; reserve expansion not implemented in pilot' };
      }
    }
    // Destination can fail after selection; try a reserve instead before sending.
    let valid = false;
    try { valid = await checkDestination(row.candidate.url); } catch { /* recover below */ }
    if (!valid) {
      state.history.push({ channel, hash: row.contentHash, at: clock() });
      delete state.outbox[key]; event(slot, 'destination_changed_select_replacement');
      return runSlot({ slot, channel, snapshot: null });
    }
    row.attempts++;
    row.status = 'uncertain'; // Persist before sending in the production transactional adapter.
    try {
      const receipt = await provider.publish({ key, channel, text: row.candidate.text + '\n' + row.candidate.url });
      if (!receipt || receipt.status !== 'published' || !receipt.id) return row;
      row.status = 'published'; row.receipt = receipt.id;
      state.history.push({ channel, hash: row.contentHash, at: clock() }); event(slot, 'published');
    } catch (e) {
      if (e.definitelyNotAccepted === true) {
        row.status = 'retry_due'; row.retryAt = clock() + Math.min(3600000, 60000 * 2 ** (row.attempts - 1));
        event(slot, 'delivery_retry_due');
      } else event(slot, 'delivery_uncertain_reconcile_first');
    }
    return row;
  }
  return { runSlot };
}
module.exports = { createPilot, freshReport, evergreen };
