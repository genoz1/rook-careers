// Server-only ROOK V9 first-paid subscription measurement. No campaign operations.
const crypto = require('node:crypto');
const CONVERSION_ID = '31096658';
const ACCOUNT_URN = 'urn:li:sponsoredAccount:557944801';
const VERSION = '202606';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function eligible(profile) {
  return profile?.trial_source === 'v9' && String(profile.utm_source || '').trim().toLowerCase() === 'linkedin';
}
function receiptFields(profile, invoice, env = process.env) {
  if (!env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN || !eligible(profile)) return {};
  if (invoice.billing_reason !== 'subscription_create' || invoice.currency !== 'usd') return {};
  const email = String(profile.email || '').trim().toLowerCase();
  if (!invoice.id || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('LinkedIn paid conversion is missing its existing matching data');
  return {linkedin_invoice_id:invoice.id,linkedin_email_sha256:hash(email)};
}
function payloadFor(record, invoice) {
  if (record.event_type !== 'paid_subscription_started' || !record.event_key?.startsWith('first_paid_') ||
      record.linkedin_invoice_id !== invoice.id || record.linkedin_sent_at ||
      invoice.billing_reason !== 'subscription_create' || invoice.currency !== 'usd' ||
      invoice.status !== 'paid' || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0 ||
      !(invoice.subscription || invoice.parent?.subscription_details?.subscription)) return null;
  const happened = Date.parse(record.occurred_at);
  if (!Number.isFinite(happened) || !/^[a-f0-9]{64}$/.test(record.linkedin_email_sha256 || '') ||
      !/^[a-z]{3}$/i.test(invoice.currency || '')) throw Error('LinkedIn paid conversion has invalid durable matching data');
  // The ROOK ledger retains all six original UTMs; LinkedIn matches using hashed email.
  // No raw email, user ID, names, IPs, new identifiers, or arbitrary UTM fields are sent.
  return {conversion:'urn:lla:llaPartnerConversion:'+CONVERSION_ID,conversionHappenedAt:happened,
    conversionValue:{currencyCode:invoice.currency.toUpperCase(),amount:(invoice.amount_paid/100).toFixed(2)},
    user:{userIds:[{idType:'SHA256_EMAIL',idValue:record.linkedin_email_sha256}]},
    eventId:hash('rook-linkedin:'+record.event_key)};
}
async function sendPaidConversion({record,invoice,env=process.env,fetchImpl=global.fetch}) {
  if (!env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN) return {sent:false};
  const payload = payloadFor(record,invoice);
  if (!payload) return {sent:false};
  let response;
  try {
    response = await fetchImpl('https://api.linkedin.com/rest/conversionEvents',{method:'POST',
      headers:{Authorization:'Bearer '+env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN,'Content-Type':'application/json',
        'LinkedIn-Version':VERSION,'X-Restli-Protocol-Version':'2.0.0'},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  } catch (_) { throw Error('LinkedIn paid-conversion delivery unavailable'); }
  if (response.status !== 201) throw Error('LinkedIn paid-conversion delivery failed (HTTP '+response.status+')');
  return {sent:true};
}
async function deliverPaidConversion({db,eventKey,invoice,env=process.env,fetchImpl=global.fetch}) {
  if (!env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN) return {sent:false};
  const result = await db.from('ad_conversion_events')
    .select('event_key,event_type,occurred_at,linkedin_invoice_id,linkedin_email_sha256,linkedin_sent_at')
    .eq('event_key',eventKey).maybeSingle();
  if (result.error) throw Error('LinkedIn paid-conversion receipt read failed');
  if (!result.data?.linkedin_invoice_id) return {sent:false}; // Historical rows are never backfilled.
  const delivery = await sendPaidConversion({record:result.data,invoice,env,fetchImpl});
  if (delivery.sent) {
    const saved = await db.from('ad_conversion_events').update({linkedin_sent_at:new Date().toISOString()}).eq('event_key',eventKey);
    if (saved.error) throw Error('LinkedIn paid-conversion receipt write failed');
  }
  return delivery;
}
async function verifyAuthorization({env=process.env,fetchImpl=global.fetch}={}) {
  if (!env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN) throw Error('LinkedIn server secret is not configured');
  let response;
  try { response = await fetchImpl('https://api.linkedin.com/rest/conversions/'+CONVERSION_ID,{method:'GET',
    headers:{Authorization:'Bearer '+env.LINKEDIN_CONVERSIONS_ACCESS_TOKEN,'LinkedIn-Version':VERSION,'X-Restli-Protocol-Version':'2.0.0'},signal:AbortSignal.timeout(10000)}); }
  catch (_) { throw Error('LinkedIn authorization check unavailable'); }
  if (!response.ok) throw Error('LinkedIn authorization check failed (HTTP '+response.status+')');
  const definition = await response.json();
  if (definition.account !== ACCOUNT_URN || String(definition.id) !== CONVERSION_ID) throw Error('LinkedIn conversion/account verification failed');
  return {authorized:true,account:'557944801',conversion:CONVERSION_ID};
}
module.exports={eligible,receiptFields,payloadFor,sendPaidConversion,deliverPaidConversion,verifyAuthorization};
