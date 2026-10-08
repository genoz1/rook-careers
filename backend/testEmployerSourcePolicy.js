const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  blockedEmployerReason,
  isBlockedEmployerSource,
} = require('./employerSourcePolicy');
const { isSalesAdmissibleJob } = require('./relevanceFilter');

test('Petco / Vet Receptionists sources are blocked', () => {
  assert.match(blockedEmployerReason({
    company_name: 'Vet Receptionists',
    careers_url: 'https://careers.petco.com/',
    ats_type: 'talentbrew',
    ats_identifier: 'careers.petco.com',
  }) || '', /pet retail/i);
  assert.equal(isBlockedEmployerSource({
    company_name: 'Some Vet Brand',
    careers_url: 'https://careers.petco.com/job/sales-associate',
  }), true);
  assert.equal(isBlockedEmployerSource({
    company_name: 'IDEXX',
    careers_url: 'https://careers.idexx.com/',
  }), false);
});

test('retail store sales titles are not sales-admissible', () => {
  for (const title of [
    'Sales Associate',
    'Seasonal Sales Associate',
    'Retail Sales Associate',
    'Store Associate',
    'Retail Media Network Sales Partner',
  ]) {
    assert.equal(isSalesAdmissibleJob({ title }), false, title);
  }
  assert.equal(isSalesAdmissibleJob({ title: 'Veterinary Sales Specialist - Tampa' }), true);
  assert.equal(isSalesAdmissibleJob({ title: 'Territory Sales Manager' }), true);
});

test('discovery and ingest call the source policy gate', () => {
  const pipeline = fs.readFileSync(path.join(__dirname, 'discovery', 'pipeline.js'), 'utf8');
  assert.match(pipeline, /blockedEmployerReason/);
  assert.match(pipeline, /rejected_policy/);
  const ingest = fs.readFileSync(path.join(__dirname, 'ingest.js'), 'utf8');
  assert.match(ingest, /blockedEmployerReason/);
  assert.match(ingest, /policyReason/);
});

test('dashboard résumé picker uses a label so the OS dialog is not delayed by JS click', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rook-dashboard-v8.html'), 'utf8');
  assert.match(html, /for="profileGateResumeInput"/);
  assert.match(html, /id="profileGateResumeInput"/);
  assert.doesNotMatch(html, /drop\.onclick\s*=\s*\(\)\s*=>\s*fileInput\.click\(\)/);
});

test('resume page file control is enabled without waiting on résumé URL fetch', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'rook-resume.html'), 'utf8');
  assert.match(html, /for="resumeFile"/);
  assert.match(html, /id="resumeFile"[^>]*accept=/);
  assert.match(html, /byId\('resumeFile'\)\.disabled\s*=\s*false/);
});
