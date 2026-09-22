const assert = require('node:assert/strict');
const { test } = require('node:test');
const { titleLooksRelevant } = require('./relevanceFilter');
const { deterministicJobAnalysis } = require('./deterministicJobAnalysis');

const obviousSales = [
  'Account Executive', 'Territory Manager', 'Territory Sales Manager', 'Account Manager',
  'Key Account Manager', 'Regional Sales Manager',
  'Business Development Manager', 'Clinical Account Executive', 'Clinical Sales Specialist',
  'Strategic Account Executive', 'Sales Representative', 'Associate Territory Representative',
];

test('obvious legitimate sales titles are retained and enriched without Anthropic', () => {
  for (const title of obviousSales) {
    assert.equal(titleLooksRelevant(title), true, title);
    const analysis = deterministicJobAnalysis(title);
    assert.ok(analysis, title);
    assert.deepEqual(analysis.sales_motion, ['sales']);
    assert.equal(analysis.analysis_source, 'deterministic_evidence');
  }
});

test('obvious non-sales jobs remain excluded before enrichment', () => {
  for (const title of ['Sales Training Manager', 'Sales Operations Manager', 'Medical Director',
    'Clinical Research Manager', 'Diagnostics Technical Support Representative',
    'Principal Field Clinical Procedure Specialist']) {
    assert.equal(titleLooksRelevant(title), false, title);
    assert.equal(deterministicJobAnalysis(title), null, title);
  }
});

test('ambiguous relevant titles are retained with enrichment safely deferred', () => {
  for (const title of ['Clinical Specialist', 'District Manager']) {
    assert.equal(titleLooksRelevant(title), true, title);
    assert.equal(deterministicJobAnalysis(title), null, title);
  }
});

test('ingestion has no Anthropic analysis dependency or failure path', () => {
  const fs = require('node:fs');
  for (const file of ['./ingest', './ingestAdzuna', './routes/recruiterPostings']) {
    const source = fs.readFileSync(require.resolve(file), 'utf8');
    assert.doesNotMatch(source, /ai\/jobAnalysis|analyzeJob\s*\(/, file);
    assert.match(source, /deterministicJobAnalysis\(/, file);
  }
});
