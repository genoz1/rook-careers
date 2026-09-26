// Adapted from Florida Buzz's photos + container/status/media_publish workflow.
// Separate ROOK-only variables; no automatic fallback to Florida Buzz tokens.
require('dotenv').config();
const {db,result}=require('./store');
const {origin,urlFor}=require('./catalog');
function config(){
 const version=process.env.ROOK_META_GRAPH_VERSION||'v24.0';
 if(!/^v\d+\.0$/.test(version))throw Error('Invalid ROOK_META_GRAPH_VERSION');
 const token=process.env.ROOK_META_ACCESS_TOKEN||process.env.ROOK_FB_PAGE_ACCESS_TOKEN;
 if(!token)throw Error('Add ROOK_META_ACCESS_TOKEN: a Meta user access token with Page and Instagram publishing permissions');
 return {version,page:process.env.ROOK_FB_PAGE_ID,token,ig:process.env.ROOK_INSTAGRAM_USER_ID};
}
async function graph(path,params={},method='GET',deps={}){
 const c=deps.config||config();const url=new URL(`https://graph.facebook.com/${c.version}/${path}`);
 const opts={method,headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(20000)};
 if(method==='GET')url.search=new URLSearchParams(params);else{opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(params);}
 const response=await (deps.fetch||fetch)(url,opts);const data=await response.json();
 if(!response.ok||data.error)throw Error('Meta request failed ('+response.status+'); inspect permissions without logging tokens');
 return data;
}
async function resolve(deps={}){
 const c=deps.config||config();
 const fields='id,name,access_token,instagram_business_account{id,username}';
 let page;
 if(c.page){
  page=await graph(c.page,{fields},'GET',{...deps,config:c});
  if(String(page.id)!==String(c.page)||!/\brook\b/i.test(page.name||''))throw Error('Token identity does not match the configured ROOK Page');
 }else{
  const accounts=await graph('me/accounts',{fields,limit:'100'},'GET',{...deps,config:c});
  const matches=(accounts.data||[]).filter(p=>/\brook\b/i.test(p.name||''));
  if(matches.length!==1)throw Error('Token identity does not match one unambiguous ROOK Page');
  page=matches[0];
 }
 const permissions=await graph('me/permissions',{},'GET',{...deps,config:c});
 const granted=new Set((permissions.data||[]).filter(p=>p.status==='granted').map(p=>p.permission));
 const facebook=!!page.access_token&&['pages_show_list','pages_manage_posts','pages_read_engagement'].every(p=>granted.has(p));
 const instagram=facebook&&!!page.instagram_business_account?.id&&(!c.ig||String(page.instagram_business_account.id)===String(c.ig))&&['instagram_basic','instagram_content_publish'].every(p=>granted.has(p));
 return {config:{...c,page:page.id,ig:page.instagram_business_account?.id,token:page.access_token},report:{page:{id:page.id,name:page.name},instagramAccount:page.instagram_business_account||null,facebook:facebook?'PASS':'FAIL',instagram:instagram?'PASS':'FAIL'}};
}
async function check(deps={}){return (await resolve(deps)).report;}
function captionFor(a,channel){
 if(channel==='instagram')return a.social_copy.instagram.replace(/https?:\/\/\S+|www\.\S+/gi,'').replace(/(?:read the full guide\s*[—–-]?\s*)?link in bio[.!]?/gi,'').trim()+'\n\nRead the full guide — link in bio.';
 return a.social_copy[channel]+'\n\n'+urlFor(a.slug);
}
async function sendArticle(a,channel,deps={}){
 const client=deps.db||db();
 const resolved=await resolve(deps),c=resolved.config;
 const sendDeps={...deps,config:c};
 await (deps.verify||require('./worker').verifyPublic)(a,client);
 const report=resolved.report;if(report[channel]!=='PASS')throw Error(channel+' permissions/identity not verified');
 // Both APIs can accept a post before a timeout; never blindly resend an uncertain mutation.
 const claimed=await result(client.from('resource_distribution').update({state:'sending',updated_at:new Date().toISOString()}).eq('article_slug',a.slug).eq('channel',channel).eq('state','queued').select('*'));
 if(!claimed?.length)return {state:'already_claimed'};
 try{
  let post;
  const caption=captionFor(a,channel);
  const imageUrl=urlFor(a.slug)+'social.jpg';
  if(channel==='facebook')post=await graph(c.page+'/photos',{url:imageUrl,caption},'POST',sendDeps);
  else{
   const container=await graph(c.ig+'/media',{image_url:imageUrl,caption},'POST',sendDeps);
   if(!container.id)throw Error('No container receipt');
   await result(client.from('resource_distribution').update({receipt:{container_id:container.id}}).eq('article_slug',a.slug).eq('channel',channel));
   let ready=false;
   for(let i=0;i<10;i++){
    const status=await graph(container.id,{fields:'status_code'},'GET',sendDeps);
    if(status.status_code==='FINISHED'){ready=true;break;}
    if(['ERROR','EXPIRED'].includes(status.status_code))break;
    await (deps.sleep||((ms)=>new Promise(r=>setTimeout(r,ms))))(2000);
   }
   if(!ready)throw Error('Instagram container not ready; reconcile before retry');
   post=await graph(c.ig+'/media_publish',{creation_id:container.id},'POST',sendDeps);
  }
  if(!post.id)throw Error('Meta did not return a receipt');
  await result(client.from('resource_distribution').update({state:'sent',receipt:{...post,source:'meta'},updated_at:new Date().toISOString()}).eq('article_slug',a.slug).eq('channel',channel));
  return post;
 }catch(e){await result(client.from('resource_distribution').update({state:'uncertain'}).eq('article_slug',a.slug).eq('channel',channel));throw e;}
}
async function dispatch(deps={}){
 const client=deps.db||db();
 for(const channel of ['facebook','instagram']){
  if(process.env['RESOURCES_'+channel.toUpperCase()+'_ENABLED']==='false'||!process.env.ROOK_META_ACCESS_TOKEN)continue;
  try {
  const queue=await result(client.from('resource_distribution').select('article_slug').eq('channel',channel).eq('state','queued').limit(2));
  for(const row of queue){const a=await result(client.from('resource_articles').select('*').eq('slug',row.article_slug).not('public_verified_at','is',null).gte('published_at',new Date(Date.now()-3*86400000).toISOString()).maybeSingle());if(a)await sendArticle(a,channel,deps);}
  } catch { console.warn('[resources] '+channel+' deferred; other channels continue'); }
 }
}
if(require.main===module)(async()=>{
 if(process.argv[2]==='check')return console.log(await check());
 if(process.argv[2]==='test'&&process.argv.includes('--confirm-post')){
  const channel=process.argv[3],slug=process.argv[4];
  if(!['facebook','instagram'].includes(channel)||!slug)throw Error('Specify facebook|instagram and a published resource slug');
  const a=await result(db().from('resource_articles').select('*').eq('slug',slug).single());console.log(await sendArticle(a,channel));return;
 }
 throw Error('Use check | test facebook|instagram SLUG --confirm-post');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={check,graph,sendArticle,dispatch,captionFor};
