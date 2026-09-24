const {test}=require('node:test'),assert=require('node:assert/strict');
const {pdf,structured}=require('./fixtures/resume/realisticPdf');
const {analyzeResume}=require('./ai/resumeAnalysis');
const parse=require('pdf-parse');
test('real PDF typography and terminal periods preserve literal facts',async()=>{
 const {text}=await parse(pdf());
 assert(text.includes('company’s'));assert(/long-\s*\nterm/.test(text));
 const result=await analyzeResume(text,{callAI:async()=>structured});
 assert.deepEqual(result,structured);
});
test('grounding still rejects altered figures, negation, invented claims and decimal prefixes',async()=>{
 const {text}=await parse(pdf());
 for(const achievement of [
  structured.employers[0].achievements.replace('103.7%','130.7%'),
  structured.employers[0].achievements.replace('Renewed','Did not renew'),
  'Managed 12 direct reports.',
  'Generated $250,000+ in new business.',
  "Managed the company's regional territory and achieved 103."
 ]) {
  const response=structuredClone(structured);response.employers[0].achievements=achievement;
  await assert.rejects(analyzeResume(text,{callAI:async()=>response}),/unsupported achievements/);
 }
});
