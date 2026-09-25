const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const sharp=require('sharp');
const {renderBrandedCard,prepareMarketingGraphic}=require('./socialBrandedCard');
const {INSIGHTS,VALUES,CARD_POINTS,selectEditorial}=require('./socialEditorial');
const {preflightCheckMedia}=require('./socialMediaPreflight');
const {createPost}=require('./socialBuffer');
const {ensureBucketExists}=require('./socialMediaStorage');
const {regularPost}=require('./socialContentPlan');
// Explicit synthetic fixtures only; never published or presented as live jobs.
const medical={title:'Medical device sales',category:'Medical Device',location_display:'Test location',post_kind:'featured'};
const veterinary={title:'Veterinary sales',category:'Veterinary',post_kind:'match'};
test('approved assets and caption rotation are valid and safe',async()=>{
 const catalog=require('./socialApprovedCatalog.json'),recent=[],hashes=new Set();
 for(const graphicId of new Set(catalog.map(c=>c.graphicId))){const buffer=await renderBrandedCard({graphicId});const m=await sharp(buffer).metadata();assert.deepEqual([m.width,m.height,m.format],[1024,1024,'jpeg']);hashes.add(require('crypto').createHash('sha256').update(buffer).digest('hex'));}
 assert.equal(hashes.size,5);
 for(let i=0;i<catalog.length;i++){const c=selectEditorial({recent});assert(c.graphicId);assert.match(c.headline,/SALES JOBS/);assert(!recent.includes(c.linkedin));recent.push(c.linkedin);}
 assert.throws(()=>selectEditorial({recent}),/exhausted/);
 await assert.rejects(renderBrandedCard({graphicId:'../../secret'}),/Unknown/);
 const job=selectEditorial({category:'Medical Device'});assert(!job.graphicId);assert.doesNotMatch(job.text,/animal health|laboratory/i);
});
test('hosted JPEG fetched anonymously, decoded, and included in actual Buffer GraphQL payload',async()=>{
 const copy=selectEditorial({theme:'value',dateStr:'2026-09-24'}),slot={slot:'marketing-3',dateStr:'2026-09-24',kind:'value'};
 let hosted,uploads=0,publicChecks=0,captured;
 const server=http.createServer((req,res)=>{assert.equal(req.headers.authorization,undefined);publicChecks++;res.writeHead(200,{'content-type':'image/jpeg'});res.end(hosted);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='https://storage.example.test/social-creatives/card.jpg';
 try {
  const media=await prepareMarketingGraphic({},slot,copy,{
   uploadGraphicToStorage:async(_,args)=>{uploads++;hosted=args.buffer;assert.match(args.contentVersion,/^[a-f0-9]{20}$/);return {publicUrl:url};},
   preflightCheckMedia:u=>preflightCheckMedia(u,{httpFetch:(_,options)=>fetch(`http://127.0.0.1:${server.address().port}/card.jpg`,options)})
  });
  assert.equal(uploads,1);assert.equal(publicChecks,1);assert.equal(media.mediaPreflight.width,1024);
  const post=await createPost('fake',{channelId:'linkedin-test',text:regularPost(slot,'linkedin',copy),photoUrl:media.photoUrl,mode:'customScheduled',dueAt:'2030-01-01T13:00:00Z'},{httpFetch:async(_,options)=>{
   captured=JSON.parse(options.body);return {ok:true,text:async()=>JSON.stringify({data:{createPost:{post:{id:'mock-receipt',status:'scheduled',assets:[{mimeType:'image/jpeg',source:url}]}}}})};
  }});
  assert.deepEqual(captured.variables.input.assets,[{image:{url}}]);
  assert.match(captured.variables.input.text,/utm_source=linkedin&utm_medium=social&utm_campaign=organic&utm_content=value/);
  assert.equal(post.assets[0].source,url);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('corrupt image, HTML, body failure and redirect cannot pass preflight',async()=>{
 const fake=(body,type='image/jpeg',status=200)=>({status,headers:{get:()=>type},arrayBuffer:async()=>body});
 for(const reply of [fake(Buffer.from([255,216,255,0])),fake(Buffer.from('<html/>'),'text/html'),fake(Buffer.alloc(0)),fake(Buffer.alloc(0),'image/jpeg',302),{...fake(Buffer.alloc(0)),arrayBuffer:async()=>{throw Error('connection closed')}}]) {
  const result=await preflightCheckMedia('https://example.test/card.jpg',{httpFetch:async()=>reply});assert.equal(result.ok,false);assert.ok(result.reason);
 }
});
test('upload and public-media failures reject before a send can be prepared',async()=>{
 const slot={dateStr:'2026-09-24',slot:'marketing-1'},copy=selectEditorial({theme:'education'});
 await assert.rejects(prepareMarketingGraphic({},slot,copy,{uploadGraphicToStorage:async()=>{throw Error('storage down')}}),/storage down/);
 await assert.rejects(prepareMarketingGraphic({},slot,copy,{uploadGraphicToStorage:async()=>({publicUrl:'https://example.test/card.jpg'}),preflightCheckMedia:async()=>({ok:false,reason:'HTML'})}),/HTML/);
 await assert.rejects(ensureBucketExists({storage:{listBuckets:async()=>({data:[{name:'social-creatives'}]}),updateBucket:async()=>({error:{message:'denied'}})}}),/denied/);
});
