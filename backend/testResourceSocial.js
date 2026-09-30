const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {captionFor}=require('./resources/meta');
const {renderResourceGraphic}=require('./resources/socialGraphic');
const {createRouter}=require('./resources/routes');
test('Facebook and Instagram resource posts lead to the article with channel attribution',()=>{
 const a={slug:'sales-guide',social_copy:{instagram:'Plan your next career move. https://rookcareers.com/resources/sales-guide/ Link in bio.',facebook:'Facebook original copy.'}};
 const ig=captionFor(a,'instagram');assert.ok(!/link in bio/i.test(ig));assert.match(ig,/go\/instagram\/resources\/sales-guide/);
 assert.equal(captionFor(a,'facebook'),'Facebook original copy.\n\nhttps://rookcareers.com/go/facebook/resources/sales-guide');
});
test('Resources social endpoint returns a square JPEG and rejects missing articles',async()=>{
 let found=true;
 const client={from(){return {select(){return this;},eq(){return this;},maybeSingle(){return Promise.resolve({data:found?{title:'Diagnostics Sales Careers: A Guide to Laboratory and Molecular Sales',category:'diagnostics-laboratory'}:null});}};}};
 const route=createRouter({db:client}).stack.find(l=>l.route?.path==='/resources/:slug/social.jpg').route;
 let body,status=200,mime;const res={set(){return this;},status(s){status=s;return this;},type(t){mime=t;return this;},send(b){body=b;return this;}};
 await route.stack[0].handle({params:{slug:'guide'}},res);
 assert.equal(status,200);assert.equal(mime,'image/jpeg');const m=await sharp(body).metadata();assert.equal(m.width,1080);assert.equal(m.height,1080);assert.equal(m.format,'jpeg');
 found=false;await route.stack[0].handle({params:{slug:'missing'}},res);assert.equal(status,404);
 await assert.rejects(renderResourceGraphic({title:'',category:'career-advice'}));
});
