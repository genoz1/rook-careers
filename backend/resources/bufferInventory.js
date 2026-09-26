const {result}=require('./store');
const {origin,urlFor}=require('./catalog');
async function choose(client,slot){
 if(process.env.RESOURCES_BUFFER_ENABLED!=='true'||!['marketing-1','marketing-2'].includes(slot.slot))return null;
 try{
  const pending=await result(client.from('resource_distribution').select('article_slug').eq('channel','linkedin').eq('state','queued').limit(500));
  if(!pending.length)return null;
  const articles=await result(client.from('resource_articles').select('slug,title,description,image_path,social_copy,public_verified_at').in('slug',pending.map(p=>p.article_slug)).not('public_verified_at','is',null).order('published_at',{ascending:true}).limit(500));
  const sends=await result(client.from('social_queue_sends').select('payload').like('run_key','%'));
  const used=new Set((sends||[]).map(r=>r.payload?.mediaEvidence?.resourceSlug).filter(Boolean));
  const a=articles.find(a=>!used.has(a.slug));if(!a)return null;
  await require('./worker').verifyPublic(a,client);
  const copy={headline:a.title,linkedin:a.social_copy.linkedin,facebook:a.social_copy.facebook,personal:a.social_copy.personal,resource_url:urlFor(a.slug)};
  return {copy,media:{photoUrl:origin()+a.image_path,editorial:copy,resourceSlug:a.slug}};
 }catch{console.warn('[resources] Article inventory deferred; existing social content remains available');return null;}
}
async function record(client,slug,channel,post){
 if(!slug)return;
 await result(client.from('resource_distribution').update({state:'sent',receipt:post,updated_at:new Date().toISOString()}).eq('article_slug',slug).eq('channel',channel));
}
async function directMetaReady(client,slug){
 try{
  const own=await result(client.from('resource_distribution').select('state,receipt').eq('article_slug',slug).eq('channel','facebook').maybeSingle());
  // Do not duplicate an accepted/uncertain direct post even if Instagram needs repair.
  if(own&&['sending','uncertain'].includes(own.state))return true;
  if(own?.state==='sent'&&own.receipt?.source==='meta')return true;
  if(!process.env.ROOK_META_ACCESS_TOKEN)return false;
  const proofs=await result(client.from('resource_distribution').select('channel,receipt').in('channel',['facebook','instagram']).eq('state','sent').limit(1000));
  const verified=new Set(proofs.filter(p=>p.receipt?.source==='meta').map(p=>p.channel));
  if(!verified.has('facebook')||!verified.has('instagram'))return false;
  const report=await require('./meta').check();return report.facebook==='PASS'&&report.instagram==='PASS';
 }catch{return false;}
}
module.exports={choose,record,directMetaReady};
