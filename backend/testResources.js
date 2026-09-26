const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const {PGlite}=require('@electric-sql/pglite');
const topics=require('./resources/topics');
const {slots,verifyPublic,tick}=require('./resources/worker');
const {imageFor}=require('./resources/catalog');
const {validate}=require('./resources/content');
const {createRouter}=require('./resources/routes');
const views=require('./resources/views');
const {check}=require('./resources/meta');
const a={slug:topics[0].slug,title:topics[0].title,category:'medical-device',description:'Practical advice for preparing your transition into medical device sales.',body_html:'<p>Article</p>',image_path:imageFor('medical-device'),image_alt:'Medical equipment',sources:[],word_count:1100,published_at:'2026-09-25T13:00:00Z',updated_at:'2026-09-25T13:00:00Z'};
test('210 distinct curated topics; image rotation; schedules across DST',()=>{
 assert.equal(topics.length,210);assert.equal(new Set(topics.map(t=>t.slug)).size,210);assert.equal(topics.filter(t=>t.category==='industry-news').length,0);
 assert.notEqual(imageFor('medical-device'),imageFor('medical-device',imageFor('medical-device')));
 assert.deepEqual(slots(new Date('2026-09-25T22:00Z')).map(s=>s.due),['2026-09-25T13:00:00.000Z','2026-09-25T19:00:00.000Z']);
 assert.deepEqual(slots(new Date('2026-11-02T23:00Z')).map(s=>s.due),['2026-11-02T14:00:00.000Z','2026-11-02T20:00:00.000Z']);assert.throws(()=>slots(new Date(),0));
});
test('migration, idempotent claims, restart fencing, transaction and permissions',async()=>{
 const pg=new PGlite();
 try{
 await pg.exec('create role anon;create role authenticated;create role service_role;');
 const sql=fs.readFileSync(__dirname+'/db/resources.sql','utf8');await pg.exec(sql);await pg.exec(sql);
 for(const t of topics.slice(0,3))await pg.query('insert into resource_topics(slug,title,category,intent,audience) values($1,$2,$3,$4,$5)',[t.slug,t.title,t.category,t.intent,t.audience]);
 const first='00000000-0000-0000-0000-000000000001',second='00000000-0000-0000-0000-000000000002';
 const claim=async(owner,slot=0)=>(await pg.query("select claim_resource_slot('2020-01-01',$1,'2020-01-01T09:00Z',$2) as t",[slot,owner])).rows[0].t;
 const picked=await claim(first);assert.ok(picked.slug);assert.equal(await claim(second),null);assert.equal(await claim(second,1),null);
 await pg.exec("update resource_slots set lease_until=now()-interval '1 minute'");assert.equal((await claim(second)).slug,picked.slug);
 const data={description:a.description,body_html:a.body_html,body_hash:'hash-1',image_path:a.image_path,image_alt:'Equipment',sources:[],social_copy:{},word_count:1100,url:'https://rookcareers.com/resources/'+picked.slug+'/'};
 await assert.rejects(pg.query("select finish_resource_slot('2020-01-01',0,$1,$2::jsonb)",[first,JSON.stringify(data)]),/lease lost/);
 await pg.query("select finish_resource_slot('2020-01-01',0,$1,$2::jsonb)",[second,JSON.stringify(data)]);
 assert.equal(await claim(first),null);assert.equal((await pg.query('select * from resource_distribution')).rows.length,4);
 const next=await claim(first,1);assert.ok(next.slug);
 await pg.query("select finish_resource_slot('2020-01-01',1,$1,null,'Invalid article')",[first]);assert.equal((await pg.query('select status from resource_topics where slug=$1',[next.slug])).rows[0].status,'rejected');
 await pg.exec('set role anon');await assert.rejects(pg.query('select * from resource_topics'),/permission denied/);
 }finally{await pg.close();}
});
test('public routes return indexable HTML without authentication; missing articles are 404',async()=>{
 const express=require('express');const app=express();
 const client={from(){return {select(){return this;},eq(){return this;},maybeSingle(){return Promise.resolve({data:a});}};}};
 app.use(createRouter({db:client,articles:async()=>({items:[a],count:1}),jobs:async()=>({})}));
 const router=app._router.stack.find(layer=>layer.name==='router').handle;
 const request=async(path,params={},query={})=>{
  const route=router.stack.find(layer=>layer.route?.path===path).route;
  let body='',status=200,headers={};const res={set(k,v){headers[k.toLowerCase()]=v;return this;},status(n){status=n;return this;},type(){return this;},send(x){body=x;return this;}};
  await route.stack[0].handle({params,query},res);return {body,status,headers};
 };
 for(const [path,params] of [['/resources',{}],['/resources/category/:category',{category:'medical-device'}],['/resources/:slug',{slug:a.slug}]]){
  const res=await request(path,params);assert.equal(res.status,200);assert.ok(res.body.includes('rel="canonical"'));assert.ok(!res.body.includes('noindex'));assert.ok(res.body.includes('/rook-onboarding-v7.html'));
 }
 assert.equal((await request('/resources/category/:category',{category:'missing'})).status,404);
 assert.equal((await request('/resources',{}, {q:'medical'})).headers['x-robots-tag'],'noindex, follow');

});
test('article metadata escapes text and emits Article schema',()=>{
 const html=views.article({...a,title:'<script>alert(1)</script>'});assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('"@type":"Article"'));assert.ok(html.includes('"@type":"BreadcrumbList"'));
});
test('unsafe and malformed article output is rejected before storage',()=>{
 const value={description:a.description,body_html:'<p onclick="bad()">bad</p>',image_alt:'Equipment',sources:[{title:'Source',url:'https://example.com/'}],social_copy:{linkedin:'A'.repeat(40),personal:'B'.repeat(40),facebook:'C'.repeat(40),instagram:'D'.repeat(40)}};
 assert.throws(()=>validate(value,topics[0]),/Unsafe/);
 assert.throws(()=>validate({...value,body_html:'<h2>Heading</h3>'},topics[0]),/Unbalanced/);
 assert.throws(()=>validate({...value,body_html:'<script>bad()</script>'},topics[0]),/Unsupported/);
});
test('public URL failure cannot enqueue social or delete a published article',async()=>{
 let writes=0;const client={from(){writes++;throw Error('Must not write');}};
 await assert.rejects(verifyPublic(a,client,async()=>new Response('missing',{status:404})),/verification/);assert.equal(writes,0);
 await assert.rejects(verifyPublic(a,client,async()=>new Response('<html>wrong</html>',{headers:{'content-type':'text/html'}})),/mismatch/);assert.equal(writes,0);
});
test('disabled scheduler makes no requests',async()=>{const saved=process.env.RESOURCES_AUTOPUBLISH_ENABLED;delete process.env.RESOURCES_AUTOPUBLISH_ENABLED;assert.equal((await tick({db:{from(){throw Error('Unexpected access');}}})).state,'disabled');if(saved)process.env.RESOURCES_AUTOPUBLISH_ENABLED=saved;});
test('Meta preflight rejects a non-ROOK token, never posts',async()=>{
 const calls=[];await assert.rejects(check({config:{version:'v24.0',page:'123',token:'test',ig:'789'},fetch:async(url,opts)=>{calls.push(opts.method);return Response.json({id:'456',name:'Florida Buzz'});}}),/does not match/);assert.deepEqual(calls,['GET']);
});
test('single Meta token resolves only ROOK and verifies both publishing permissions',async()=>{
 const scopes=['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'];
 const methods=[];
 const report=await check({config:{version:'v24.0',token:'test-only'},fetch:async(url,opts)=>{
  methods.push(opts.method);
  return Response.json(String(url).includes('/me/accounts')?{data:[{id:'1',name:'ROOK Medical Sales Careers',access_token:'test-page',instagram_business_account:{id:'2',username:'rook'}}]}:{data:scopes.map(permission=>({permission,status:'granted'}))});
 }});
 assert.equal(report.facebook,'PASS');assert.equal(report.instagram,'PASS');assert.deepEqual(methods,['GET','GET']);assert.ok(!JSON.stringify(report).includes('test-page'));
});
