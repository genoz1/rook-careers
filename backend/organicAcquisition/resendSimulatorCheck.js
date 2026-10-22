'use strict';
const crypto = require('node:crypto');
// A fixed provider simulator is the only recipient. No prospect input is accepted.
async function verifySimulator({confirm=false,send=require('../email/resend').sendEmail,token=process.env.RESEND_API_KEY,httpFetch=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
 if (!confirm) throw Error('Explicit Resend simulator confirmation required');
 if (!token) throw Error('Existing Resend credential required');
 const run = crypto.randomUUID();
 const to = 'delivered+rook-acq-'+run+'@resend.dev';
 const subject = 'ROOK acquisition simulator check '+run;
 const receipt = await send({to,subject,html:'<p>ROOK integration validation. Synthetic content only; no prospect or job data.</p>',idempotencyKey:'rook-acq-simulator-'+run});
 if (!receipt?.id) throw Error('No Resend simulator receipt; reconcile before retrying');
 let event;
 for (let i=0;i<5;i++) {
  if (i) await pause(2000);
  const r = await httpFetch('https://api.resend.com/emails/'+encodeURIComponent(receipt.id),{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
  if (!r.ok) throw Error('Simulator accepted; delivery readback unavailable');
  const d = await r.json();
  if (d.id !== receipt.id || d.subject !== subject || !Array.isArray(d.to) || d.to.length !== 1 || d.to[0] !== to) throw Error('Simulator receipt mismatch');
  event = d.last_event;
  if (event === 'delivered') return {receiptId:receipt.id,accepted:true,simulatedDeliveryConfirmed:true,recipient:'Resend delivered simulator',lastEvent:event,realProspectDeliveryTested:false,webhookDeliveryTested:false};
 }
 return {receiptId:receipt.id,accepted:true,simulatedDeliveryConfirmed:false,recipient:'Resend delivered simulator',lastEvent:['sent','queued'].includes(event)?event:'unconfirmed',realProspectDeliveryTested:false,webhookDeliveryTested:false};
}
module.exports = {verifySimulator};
