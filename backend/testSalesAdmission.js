const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  titleLooksRelevant,
  titleHasStrongSalesSignal,
  isSalesAdmissibleJob,
} = require('./relevanceFilter');

const BLUEPEARL_NON_SALES = [
  'Veterinary Specialist Internal Medicine',
  'Veterinary Technician Manager',
  'Veterinary Specialist Soft Tissue Surgeon',
  'Veterinary Internal Medicine Specialist',
  'Associate Veterinarian',
  'Emergency Veterinarian - BluePearl',
  'Veterinary Clinical Manager',
  'Veterinary Practice Manager',
  'Veterinary Client Service Representative',
  'Oncology Clinical Specialist',
  'Clinical Manager, RN',
  'Senior Clinical Study Manager',
  'Veterinary Relationship Manager',
  'Clinical Care Transition Specialist / RN - Houston',
  'Clinical Study Specialist',
];

const LEGITIMATE_SALES = [
  'Medical Sales Representative',
  'Territory Sales Representative',
  'Medical Device Territory Manager',
  'Diagnostics Account Executive',
  'Pharmaceutical Account Manager',
  'Veterinary Sales Representative',
  'Animal Health Territory Manager',
  'Key Account Manager',
  'Strategic Account Manager',
  'Regional Sales Manager',
  'District Sales Manager',
  'Business Development Manager',
  'Commercial Sales Director',
  'Clinical Sales Specialist',
  'Clinical Account Executive',
  'Territory Manager',
  'Account Executive',
];

test('industry vocabulary alone never admits clinical/hospital roles', () => {
  for (const title of BLUEPEARL_NON_SALES) {
    assert.equal(titleLooksRelevant(title), false, title);
    assert.equal(isSalesAdmissibleJob({ title }), false, title);
    assert.equal(titleHasStrongSalesSignal(title), false, title);
  }
});

test('legitimate medical and animal-health sales titles are admitted', () => {
  for (const title of LEGITIMATE_SALES) {
    assert.equal(titleLooksRelevant(title), true, title);
    assert.equal(isSalesAdmissibleJob({ title }), true, title);
  }
});

test('ROLE intersect DOMAIN clinical titles are rejected', () => {
  for (const title of ['Clinical Specialist', 'Diagnostic Imaging Manager', 'Medical Specialist']) {
    assert.equal(titleLooksRelevant(title), false, title);
  }
});

test('ambiguous district manager requires description sales evidence', () => {
  assert.equal(titleLooksRelevant('District Manager'), false);
  assert.equal(isSalesAdmissibleJob({
    title: 'District Manager',
    description: 'Own a sales territory, hit quarterly quota, and grow book of business with clinic customers.',
  }), true);
  assert.equal(isSalesAdmissibleJob({
    title: 'District Manager',
    description: 'Oversee clinic operations, patient care scheduling, and veterinary staff coverage.',
  }), false);
});

test('sales-adjacent operations titles remain excluded', () => {
  for (const title of [
    'Sales Training Manager',
    'Sales Operations Manager',
    'Sales Enablement Specialist',
    'Diagnostics Technical Support Representative',
    'Principal Field Clinical Procedure Specialist',
  ]) {
    assert.equal(titleLooksRelevant(title), false, title);
  }
});
