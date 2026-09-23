// Extends the existing daily digest command, matching, projection and Resend client.
const {rank}=require('../v7Matching');
const {project}=require('../pretrialProjection');
const {sendEmail}=require('./resend');
const {escapeHtml}=require('./dailyDigest');
function renderPretrialDigest(jobs,base,token) {
  // Project raw records first. No titles, employers, job IDs, prose or URLs escape.
  const rows=jobs.map(project).map(j=>`<li style="margin:20px 0"><strong>${escapeHtml(j.role_type || 'Sales opportunity')}</strong><br>${escapeHtml(j.industry_classification.labels.join(' · '))}${j.territory_type?'<br>'+escapeHtml(j.territory_type):''}<br>A new opportunity matches your ROOK search.</li>`).join('');
  return `<div style="font:16px system-ui;max-width:600px;margin:auto;color:#062d55"><h1>New ROOK matches</h1><ul>${rows}</ul><p><a href="${escapeHtml(base)}/rook-dashboard-v7.html?from=job_alert">View My Matches</a></p><p style="font-size:12px">You requested ROOK job-match emails. <a href="${escapeHtml(base)}/api/v7/alerts/unsubscribe?token=${encodeURIComponent(token)}">Unsubscribe</a></p></div>`;
}
async function sendPretrialDigest(db,lead,base,deps={}) {
  if(!lead.digest_enabled) return {sent:false,reason:'opted_out'};
  const eligible=await db.rpc('pretrial_alert_eligible',{p_id:lead.id});
  if(eligible.error) throw eligible.error;
  if(!eligible.data) return {sent:false,reason:'existing_account_or_opted_out'};
  const jobs=await (deps.rank || rank)(db,lead.profile);
  const cutoff=Math.max(Date.parse(lead.consent_at),Date.now()-7*86400000);
  const fresh=jobs.filter(j=>Date.parse(j.first_seen_at)>cutoff && j.match?.overall_score>=60);
  if(!fresh.length) return {sent:false,reason:'no_new_matches'};
  const prior=await db.from('pretrial_alert_jobs').select('job_id').eq('lead_id',lead.id).in('job_id',fresh.map(j=>j.id));
  if(prior.error) throw prior.error;
  const sent=new Set((prior.data || []).map(r=>r.job_id));
  const selected=fresh.filter(j=>!sent.has(j.id)).slice(0,5);
  if(!selected.length) return {sent:false,reason:'already_sent'};
  // Durable reservation before external delivery: races/crashes never resend jobs.
  // Ambiguous sends remain reserved; do not automatically retry them next day.
  const reserved=await db.from('pretrial_alert_jobs').insert(selected.map(j=>({lead_id:lead.id,job_id:j.id})));
  if(reserved.error?.code==='23505') return {sent:false,reason:'already_reserved'};
  if(reserved.error) throw reserved.error;
  const recheck=await db.rpc('pretrial_alert_eligible',{p_id:lead.id});
  if(recheck.error) throw recheck.error;
  if(!recheck.data) return {sent:false,reason:'opted_out_before_send'};
  await (deps.sendEmail || sendEmail)({to:lead.email,subject:`${selected.length} new ROOK match${selected.length===1?'':'es'}`,html:renderPretrialDigest(selected,base.replace(/\/$/,''),lead.unsubscribe_token),idempotencyKey:`pretrial-${lead.id}-${require('crypto').createHash('sha256').update(selected.map(j=>j.id).sort().join(',')).digest('hex')}`});
  return {sent:true,jobCount:selected.length};
}
async function sendPretrialDigests(db,base) {
  let offset=0;
  for(;;) {
    const result=await db.from('pretrial_leads').select('*').eq('digest_enabled',true).order('id').range(offset,offset+99);
    if(result.error) throw result.error;
    for(const lead of result.data || []) {
      try {const r=await sendPretrialDigest(db,lead,base);console.log('Pretrial digest',r.sent?'sent':r.reason);}
      catch(e) {console.error('Pretrial digest failed:',e.message);}
    }
    if((result.data || []).length<100) return;
    offset+=100;
  }
}
module.exports={renderPretrialDigest,sendPretrialDigest,sendPretrialDigests};
