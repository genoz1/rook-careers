'use strict';
// Read-only readiness check. Never prints secrets; never publishes or sends.
require('dotenv').config();
const env=process.env;
const names=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','ACQ_SIGNING_SECRET','STRIPE_SECRET_KEY','STRIPE_PRICE_ID_MONTHLY','ACQ_STRIPE_WEBHOOK_SECRET','BUFFER_ACCESS_TOKEN','BUFFER_ROOK_LINKEDIN_CHANNEL_ID','BUFFER_ROOK_FACEBOOK_CHANNEL_ID','ADMIN_EMAILS'];
async function run(){
 const checks=Object.fromEntries(names.map(k=>[k,Boolean(env[k])]));
 const report={checkedAt:new Date().toISOString(),configured:checks,productionReady:false,accountChecks:{},note:'Configured is not validated. Public delivery remains untested without a separately approved live post.'};
 if(env.BUFFER_ACCESS_TOKEN&&env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID&&env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID){try{const a=require('../backend/organicAcquisition/bufferAdapter').createBufferAdapter({token:env.BUFFER_ACCESS_TOKEN,linkedinChannelId:env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,facebookChannelId:env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID});report.accountChecks.bufferCompanyChannels=(await a.channels()).map(c=>({service:c.service,configured:true}));}catch{report.accountChecks.buffer='unavailable_or_not_authorized';}}
 if(env.STRIPE_SECRET_KEY){try{const stripe=new(require('stripe'))(env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:15000,maxNetworkRetries:0});const price=await stripe.prices.retrieve(env.STRIPE_PRICE_ID_MONTHLY);report.accountChecks.stripe={testMode:env.STRIPE_SECRET_KEY.startsWith('sk_test_'),preservedMonthlyPrice:price.unit_amount===1999&&price.currency==='usd'&&price.recurring?.interval==='month'};}catch{report.accountChecks.stripe='unavailable_or_not_authorized';}}
 console.log(JSON.stringify(report,null,2));
}
run().catch(()=>{console.error('Preflight unavailable; no live actions performed.');process.exitCode=1;});
