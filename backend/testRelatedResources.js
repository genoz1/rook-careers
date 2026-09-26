const test=require('node:test'),assert=require('node:assert/strict');
const {createRouter}=require('./resources/routes');
const views=require('./resources/views');
const current={slug:'current',title:'Current guide',category:'medical-device',body_html:'<p>Article content</p>',sources:[],published_at:'2020-01-01',updated_at:'2020-01-01',word_count:900};
test('related resources filter publication/category/current, limit three and update dynamically',async()=>{
 const rows=[current,...['a','b','c','d'].map(slug=>({...current,slug,title:'Guide '+slug,status:'published'})),{...current,slug:'draft',status:'queued'},{...current,slug:'rejected',status:'rejected'},{...current,slug:'future',status:'published',published_at:'2999-01-01'},{...current,slug:'other',status:'published',category:'industry-news'}];current.status='published';
 const db={from(){let filters=[],limit=Infinity;return {select(){return this;},eq(k,v){filters.push(r=>(k==='resource_topics.status'?r.status:r[k])===v);return this;},neq(k,v){filters.push(r=>r[k]!==v);return this;},lte(k,v){filters.push(r=>r[k]!=null&&r[k]<=v);return this;},order(){return this;},limit(n){limit=n;return this;},maybeSingle(){return Promise.resolve({data:current});},then(resolve,reject){return Promise.resolve({data:rows.filter(r=>filters.every(f=>f(r))).slice(0,limit)}).then(resolve,reject);}};}};
 const route=createRouter({db,jobs:async()=>({})}).stack.find(l=>l.route?.path==='/resources/:slug').route;
 async function render(){let html;await route.stack[0].handle({params:{slug:'current'}},{type(){return this;},send(b){html=b;},status(){throw Error('Unexpected failure');}});return html;}
 let html=await render();let section=html.split('id="related-resources-heading"')[1].split('</section>')[0];
 assert.equal((section.match(/<a href=/g)||[]).length,3);for(const slug of ['current','draft','rejected','future','other','d'])assert.ok(!section.includes('/resources/'+slug+'/'));
 assert.ok(html.indexOf('Article content')<html.indexOf('Related Resources'));assert.ok(html.indexOf('Related Resources')<html.indexOf('Find My Matches',html.indexOf('Related Resources')));
 rows.splice(1,4);html=await render();assert.ok(html.includes('More guides in this category'));
 rows.push({...current,slug:'new',title:'New guide'});html=await render();assert.ok(html.includes('href="/resources/new/"'));assert.ok(html.includes('rel="canonical" href="https://rookcareers.com/resources/current/"'));
});
test('related HTML excludes duplicate/current links and escapes titles',()=>{
 const html=views.article(current,[current,{slug:'a',title:'Duplicate'},{slug:'a',title:'<Guide>'}]);
 const section=html.split('id="related-resources-heading"')[1].split('</section>')[0];assert.equal((section.match(/<a href=/g)||[]).length,1);assert.ok(section.includes('&lt;Guide&gt;'));
});
