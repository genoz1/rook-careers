const {test}=require('node:test'),assert=require('node:assert/strict');
const {deterministicIndustryEvidence: evidence}=require('./deterministicJobAnalysis');
test('product evidence recognizes device and oncology products',()=>{
 for(const description of ['Sell our portfolio of stents and catheters.','Promote defibrillators and neurovascular devices.','Sales of pacing systems to hospitals.'])
 assert(evidence({description}).labels.includes('Medical Device'));
 assert(evidence({description:'Promote our oncology biologics portfolio.'}).labels.includes('Pharmaceutical'));
});
test('benefits, candidate history and EEO cannot supply industry',()=>{
 for(const description of ['Our sales employees receive dental coverage and benefits.','Qualifications: Sell medical devices successfully for at least five years.','Equal employment opportunity in our pharmaceutical sales organization.','Experience selling genomic profiling tests preferred.'])
 assert.deepEqual(evidence({title:'Account Executive',description}).labels,[],description);
});
test('qualifications section ends at responsibilities and preserves real product evidence',()=>{
 assert.deepEqual(evidence({description:'Qualifications:\nDental sales background.\nResponsibilities:\nSell diagnostic tests.'}).labels,['Diagnostics']);
});
test('Foundation uses verified employer metadata, never qualification history',()=>{
 const input={title:'Account Executive II',description:'Drive sales volume for our suite of products. Qualifications: 6+ years of direct selling diagnostics or life science.'};
 assert.deepEqual(evidence(input).labels,[]);
 assert.deepEqual(evidence({...input,employerIndustry:'Diagnostics'}).labels,['Diagnostics']);
});
test('Bionote veterinary products do not gain Dental from benefits',()=>{
 const e=evidence({title:'Veterinary Territory Sales Manager',description:'Sell our veterinary diagnostic products. Our sales team receives medical and dental insurance benefits.'});
 assert(e.labels.includes('Veterinary'));assert(e.labels.includes('Diagnostics'));assert(!e.labels.includes('Dental'));
});
