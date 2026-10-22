'use strict';
require('dotenv').config();
async function run(){
 if(!process.argv.includes('--confirm-sidecar-baseline'))throw Error('Explicit sidecar baseline confirmation required');
 const runtime=require('../backend/organicAcquisition/runtime').createRuntime();if(!runtime)throw Error('Configure the acquisition environment before baseline initialization');
 const baseline=await runtime.observer.baseline();
 if(process.env.ACQ_ENVIRONMENT==='production'&&baseline.excludedCustomers<3)throw Error('Fewer than three existing monthly customers reconciled; baseline activation refused');
 await runtime.store.call('put',{kind:'config',id:'launch',body:baseline});
 console.log(JSON.stringify({baselineComplete:true,excludedCustomers:baseline.excludedCustomers,note:'Only acquisition sidecar records written; no billing changes.'}));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
