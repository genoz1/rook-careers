'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createPilot, freshReport, evergreen } = require('./recoveryPilot');
const baseline = JSON.parse(fs.readFileSync(require.resolve('../../docs/organic-growth/baseline-inventory.json'), 'utf8'));
const NOW = Date.parse('2026-10-21T10:00:00Z');
function snapshot() { return { ...structuredClone(baseline), capturedAt: new Date(NOW).toISOString() }; }
function fixture(options = {}) {
  let now = NOW;
  const calls = []; const receipts = new Map();
  const provider = { mode: 'simulation', async publish(p) { calls.push(p); const r = { status: 'published', id: 'fake-' + calls.length }; receipts.set(p.key, r); return r; }, async reconcile(key) { return receipts.get(key) || { status: 'absent' }; }, ...options.provider };
  const state = options.state || {};
  const config = { state, provider, allowedChannels: ['mock-rook-company'], checkDestination: async () => true, clock: () => now, ...options, provider };
  return { state, calls, receipts, config, pilot: createPilot(config), advance(ms) { now += ms; } };
}
const input = extra => ({ slot: '2026-10-21-am', channel: 'mock-rook-company', snapshot: snapshot(), ...extra });
test('valid fresh aggregate is published to the simulated company channel', async () => {
  const f = fixture(); const r = await f.pilot.runSlot(input()); assert.equal(r.status, 'published'); assert.match(f.calls[0].text, /not the entire employment market/);
});
test('stale data is automatically refreshed before publication', async () => {
  const f = fixture(); const r = await f.pilot.runSlot(input({ snapshot: { ...baseline, capturedAt: '2026-10-01T00:00:00Z' }, refreshSnapshot: async () => snapshot() })); assert.equal(r.status, 'published'); assert.ok(f.state.events.some(e => e.action === 'snapshot_repaired'));
});
test('missing data plus failed refresh publishes evergreen replacement', async () => {
  const f = fixture(); const r = await f.pilot.runSlot(input({ snapshot: null, refreshSnapshot: async () => { throw Error('down'); } })); assert.equal(r.status, 'published'); assert.match(f.calls[0].text, /resume tip/);
});
test('suppressed small cell produces useful non-statistical replacement', async () => {
  const s = snapshot(); const c = s.collections.find(c => c.path === '/jobs/category/medical-device-sales-jobs'); delete c.jobs; delete c.representedEmployers; c.suppressed = true;
  const f = fixture(); assert.equal((await f.pilot.runSlot(input({ snapshot: s }))).status, 'published'); assert.match(f.calls[0].text, /resume tip/);
});
test('unexpected protected fields cannot reach publication output', async () => {
  const s = snapshot(); s.collections[0].employer = 'PRIVATE_EMPLOYER_SENTINEL'; s.title = 'PRIVATE_TITLE_SENTINEL'; s.applicationUrl = 'PRIVATE_APPLICATION_SENTINEL';
  const f = fixture(); await f.pilot.runSlot(input({ snapshot: s })); assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE_/); assert.match(f.calls[0].text, /resume tip/);
});
test('broken report destination falls back to a working guide', async () => {
  const f = fixture({ checkDestination: async url => url.includes('/resources/') }); assert.equal((await f.pilot.runSlot(input())).status, 'published'); assert.match(f.calls[0].text, /resume tip/);
});
test('broken first reserve selects the next reserve automatically', async () => {
  const f = fixture({ checkDestination: async url => url.includes('interview-questions') }); assert.equal((await f.pilot.runSlot(input({ snapshot: null }))).status, 'published'); assert.match(f.calls[0].text, /interview/);
});
test('duplicate slot and serialized restart do not publish twice', async () => {
  const f = fixture(); await f.pilot.runSlot(input()); const restored = JSON.parse(JSON.stringify(f.state)); const restarted = createPilot({ ...f.config, state: restored }); await restarted.runSlot(input()); assert.equal(f.calls.length, 1);
});
test('different slots use distinct reserve content within cooldown', async () => {
  const f = fixture(); await f.pilot.runSlot(input({ snapshot: null })); await f.pilot.runSlot(input({ snapshot: null, slot: 'next-slot' })); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0].text, f.calls[1].text);
});
test('known unaccepted delivery failure remains queued then recovers', async () => {
  const f = fixture(); const normal = f.config.provider.publish; let first = true;
  f.config.provider.publish = async p => { if (first) { first = false; throw Object.assign(Error('rate limit'), { definitelyNotAccepted: true }); } return normal(p); };
  assert.equal((await f.pilot.runSlot(input())).status, 'retry_due'); await f.pilot.runSlot(input()); assert.equal(f.calls.length, 0); f.advance(60001); assert.equal((await f.pilot.runSlot(input())).status, 'published'); assert.equal(f.calls.length, 1);
});
test('timeout after acceptance reconciles without duplicate submission', async () => {
  const f = fixture(); const normal = f.config.provider.publish; f.config.provider.publish = async p => { await normal(p); throw Error('timeout'); };
  assert.equal((await f.pilot.runSlot(input())).status, 'uncertain'); assert.equal((await f.pilot.runSlot(input())).status, 'published'); assert.equal(f.calls.length, 1);
});
test('unconfirmed provider response stays uncertain rather than counted as publication', async () => {
  const f = fixture({ provider: { publish: async () => ({ status: 'queued', id: 'queue-1' }), reconcile: async () => ({ status: 'unknown' }) } }); assert.equal((await f.pilot.runSlot(input())).status, 'uncertain'); assert.equal((await f.pilot.runSlot(input())).status, 'uncertain'); assert.equal(f.state.history.length, 0);
});
test('unapproved channels and live adapters are refused', async () => {
  const f = fixture(); await assert.rejects(f.pilot.runSlot(input({ channel: 'florida-buzz' })), /allowlisted/); assert.throws(() => createPilot({ ...f.config, provider: { mode: 'live' } }), /simulation/);
});
test('all destinations down retains explicit backlog for later recovery', async () => {
  let available = false; const f = fixture({ checkDestination: async () => available }); assert.equal((await f.pilot.runSlot(input())).status, 'backlog'); assert.equal(f.calls.length, 0); available = true; assert.equal((await f.pilot.runSlot(input())).status, 'published');
});
test('reserve capacity supports six weeks with no fresh data and no repeated posts', async () => {
  const f = fixture(); for (let i = 0; i < 18; i++) assert.equal((await f.pilot.runSlot(input({ snapshot: null, slot: 'slot-' + i }))).status, 'published'); assert.equal(new Set(f.calls.map(c => c.text)).size, 18); assert.ok(evergreen.length >= 18);
});
test('three weekly posts continue for fourteen weeks during simulated data outage', async () => {
  const f = fixture(); for (let i = 0; i < 42; i++) { assert.equal((await f.pilot.runSlot(input({ snapshot: null, slot: 'long-slot-' + i }))).status, 'published'); f.advance(56 * 3600000); } assert.equal(f.calls.length, 42);
});
test('pathological reserve exhaustion is explicit rather than false success', async () => {
  const f = fixture(); for (let i = 0; i < evergreen.length; i++) await f.pilot.runSlot(input({ snapshot: null, slot: 'burst-' + i })); assert.equal((await f.pilot.runSlot(input({ snapshot: null, slot: 'burst-overflow' }))).status, 'backlog');
});
test('future dated snapshot is never represented as current evidence', () => {
  const s = snapshot(); s.capturedAt = new Date(NOW + 1).toISOString(); assert.throws(() => freshReport(s, NOW), /future/);
});
