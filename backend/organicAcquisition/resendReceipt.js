'use strict';
// Read only: reconcile a receipt already recorded by this sidecar. Never sends mail.
async function readEmailReceipt(id,{token=process.env.RESEND_API_KEY,httpFetch=fetch}={}) {
 if (!token || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('Existing email receipt and credential required');
 const r = await httpFetch('https://api.resend.com/emails/'+encodeURIComponent(id),{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 if (!r.ok) throw Error('Email receipt reconciliation unavailable');
 const d = await r.json();
 if (d.id !== id) throw Error('Email receipt mismatch');
 const failed = ['bounced','complained','failed','suppressed'].includes(d.last_event);
 return {id,status:d.last_event==='delivered'?'delivered':failed?'failed':'accepted'};
}
module.exports = {readEmailReceipt};
