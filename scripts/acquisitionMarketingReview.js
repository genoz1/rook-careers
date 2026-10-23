'use strict';
const runtime=require('../backend/organicAcquisition/runtime').createRuntime(process.env),review=require('../backend/organicAcquisition/queueReview');
if(!runtime)throw Error('Existing acquisition runtime required');
const command=process.argv[2];
const run=command==='preview-drafts'?()=>review.previewDrafts(runtime,process.env):command==='cleanup-drafts'?()=>review.cleanupDrafts(runtime,process.env):command==='review'?()=>review.review(runtime,process.env,{apply:process.argv.includes('--apply')}):null;
if(!run)throw Error('Use preview-drafts | cleanup-drafts | review [--apply]');
run().then(r=>{console.log(JSON.stringify(r));process.exit(0);}).catch(()=>{console.error('Marketing review incomplete; receipts preserved for reconciliation. No provider bodies or credentials logged.');process.exit(1);});
