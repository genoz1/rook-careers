let client;
function db(){
 if(!client){
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error('Resources database is not configured');
  client=require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,
   {auth:{persistSession:false},global:{fetch:(url,opts={})=>fetch(url,{...opts,signal:AbortSignal.timeout(20000)})}});
 }return client;
}
async function result(query){const {data,error}=await query;if(error)throw Error('Resources database operation failed ('+(error.code||'unknown')+')');return data;}
async function articles({category,q,page=1,limit=12}={},client=db()){
 let query=client.from('resource_articles').select('slug,title,category,description,image_path,image_alt,published_at,updated_at,word_count',{count:'exact'}).order('published_at',{ascending:false}).order('slug');
 if(category)query=query.eq('category',category);
 if(q)query=query.ilike('title','%'+q.replace(/[%_\\]/g,'')+'%');
 const {data,count,error}=await query.range((page-1)*limit,page*limit-1);
 if(error)throw Error('Resources unavailable');return {items:data||[],count:count||0};
}
module.exports={db,result,articles};
