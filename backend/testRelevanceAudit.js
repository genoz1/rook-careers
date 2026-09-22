const assert = require('node:assert/strict');
const { test } = require('node:test');
const { titleLooksRelevant, titleHasStrongSalesSignal } = require('./relevanceFilter');

test('explicit sales roles survive an empty AI classification', () => {
  assert.equal(titleHasStrongSalesSignal('Territory Sales Manager- Chattanooga, Knoxville, TN'), true);
  assert.equal(titleHasStrongSalesSignal('Hematology Account Manager - Florida'), true);
});

test('finance and sales operations roles are excluded', () => {
  for (const title of ['Accounts Payable Manager', 'Accounts Receivable Specialist',
    'Sales Training Manager', 'Director, Sales Enablement', 'Executive Medical Director',
    'Salesforce Developer', 'Salesforce Manager']) {
    assert.equal(titleLooksRelevant(title), false, title);
    assert.equal(titleHasStrongSalesSignal(title), false, title);
  }
});
