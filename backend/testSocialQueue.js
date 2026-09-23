const {test}=require('node:test');
const assert=require('node:assert/strict');
const {futureSlots,durableCreate,replenish}=require('./socialQueue');
const {DAILY_SLOTS,availableCapacity,representedPost,regularPost}=require('./socialContentPlan');
const {generateMarketing,parseMarketing,validateText,similarity}=require('./socialMarketingCopy');
const {readQueue}=require('./socialBuffer');
function memoryDb() {
  const rows = [];
  let owner = null;
  return { rows,
    rpc: async (_, args) => {
      if (owner && owner !== args.lock_owner) return { data: false };
      owner = args.lock_owner; return { data: true };
    },
    from(table) {
      const filters = [];
      let changes;
      const query = {
        eq(k, v) { filters.push(row => row[k] === v); return query; },
        select() { return query; },
        limit() { return query; },
        update(value) { changes = value; return query; },
        async insert(row) {
          if (rows.some(r => r.run_key === row.run_key && r.channel_id === row.channel_id)) return { error: { code: '23505' } };
          rows.push({ ...row }); return {};
        },
        async maybeSingle() { return { data: rows.find(r => filters.every(f => f(r))) }; },
        then(resolve) {
          if (table === 'social_queue_lock') { owner = null; return resolve({}); }
          const matches = rows.filter(r => filters.every(f => f(r)));
          if (changes) matches.forEach(r => Object.assign(r, changes));
          resolve({ data: matches });
        },
      };
      return query;
    },
  };
}
const payload = { channelId: 'facebook', dueAt: '2026-09-24T12:30:00Z', text: 'Test' };

test('durable receipt prevents duplicate sends on re-entry', async () => {
  const db = memoryDb(); let calls = 0;
  const send = async () => ({ id: `post-${++calls}` });
  await durableCreate(db, 'run', 'fake', payload, send);
  const again = await durableCreate(db, 'run', 'fake', payload, send);
  assert.equal(calls, 1); assert.equal(again.id, 'post-1');
});
test('concurrent attempts send once; uncertain intent blocks the other attempt', async () => {
  const db = memoryDb(); let calls = 0;
  const send = async () => { calls++; return { id: 'post-1' }; };
  await Promise.allSettled([durableCreate(db, 'run', 'fake', payload, send), durableCreate(db, 'run', 'fake', payload, send)]);
  assert.equal(calls, 1);
});
test('explicit Buffer rejection retries, while timeout never blindly resends', async () => {
  const db = memoryDb(); let calls = 0;
  await assert.rejects(durableCreate(db, 'rejected', 'fake', payload, async () => { calls++; throw Object.assign(Error('queue full'), { isMutationError: true }); }));
  assert.equal(calls, 3); assert.equal(db.rows[0].state, 'rejected');
  let uncertain = 0;
  const send = async () => { uncertain++; throw Error('timeout after request'); };
  await assert.rejects(durableCreate(db, 'uncertain', 'fake', payload, send));
  await assert.rejects(durableCreate(db, 'uncertain', 'fake', payload, send), /uncertain/);
  assert.equal(uncertain, 1);
});
test('missing Buffer receipt leaves an uncertain intent', async () => {
  const db = memoryDb();
  await assert.rejects(durableCreate(db, 'missing', 'fake', payload, async () => undefined));
  assert.equal(db.rows[0].state, 'sending');
});
test('failure to persist Buffer receipt prevents a duplicate on retry', async () => {
  const db = memoryDb(); const original = db.from;
  db.from = table => {
    const q = original(table); const update = q.update;
    q.update = value => value.state === 'scheduled' ? { eq() { return this; }, then: resolve => resolve({ error: { message: 'offline' } }) } : update(value);
    return q;
  };
  let calls = 0; const send = async () => { calls++; return { id: 'accepted' }; };
  await assert.rejects(durableCreate(db, 'run', 'fake', payload, send), /receipt/);
  await assert.rejects(durableCreate(db, 'run', 'fake', payload, send), /uncertain/);
  assert.equal(calls, 1);
});

const channels=[{id:'li',service:'linkedin',name:'ROOK Careers',organizationId:'org'},{id:'fb',service:'facebook',name:'ROOK Careers',organizationId:'org'}];
const config={automationEnabled:'true',bufferAccessToken:'fake',linkedinChannelId:'li',facebookChannelId:'fb'};
const copy={linkedin:'Which responsibilities would you prioritize in a possible role? Consider comparing your decisions and responsibilities.',facebook:'What makes a workday satisfying for you? Think about the conversations you enjoy.',reddit:'How would you assess a possible career direction? Reflect on your questions before applying.',fallback:false};
function deps(extra={}) {return {supabaseAdmin:memoryDb(),now:new Date('2030-06-01T00:00:00Z'),listAllChannels:async()=>channels,readQueue:async(token,org)=>{assert.equal(org,"org");return {limit:10,posts:[]};},readRecentPosts:async(token,org)=>{assert.equal(org,"org");return [];},generateMarketing:async()=>copy,sendEmail:async()=>{},...extra};}
function response(value){return {status:'completed',output:[{type:'function_call',name:'write_social_marketing',arguments:JSON.stringify(value)}]};}
test('six daily slots have four regular posts and two additional job posts',()=>{
 assert.equal(DAILY_SLOTS.length,6);assert.equal(DAILY_SLOTS.filter(x=>x.slot.startsWith('marketing')).length,4);
 assert.deepEqual(DAILY_SLOTS.map(x=>[x.hour,x.minute]),[[8,30],[10,0],[13,0],[16,0],[16,30],[19,0]]);
});
test('rolling window is at most 48 hours with local-time DST-safe slots',()=>{
 for(const start of ['2026-03-07T23:00:00Z','2026-10-31T23:00:00Z','2026-09-23T12:29:00Z']){
  const now=new Date(start),slots=futureSlots(now);assert.ok(slots.length>=11&&slots.length<=12);
  for(const s of slots){assert.ok(s.dueAt>now);assert.ok(s.dueAt-now<=48*3600000);
   const clock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(s.dueAt);
   assert.equal(clock,`${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')}`);
  }
 }
});
test('actual per-channel capacity includes queued/sending posts and does not assume twelve',()=>{
 const posts=Array.from({length:9},()=>({channelId:'li',status:'scheduled'}));posts.push({channelId:'li',status:'sending'});
 assert.equal(availableCapacity(posts,'li',10),0);assert.equal(availableCapacity(posts,'fb',10),10);
 assert.throws(()=>availableCapacity(posts,'li',null));
});
test('existing scheduled slot counts even when created outside this worker',()=>{
 const slot=futureSlots(new Date('2030-06-01T00:00:00Z'))[0];const p={id:'old',channelId:'li',status:'scheduled',dueAt:slot.dueAt};
 assert.equal(representedPost([p],'li',slot).id,'old');assert.equal(representedPost([p],'fb',slot),undefined);
});
test('fresh copy accepts original channel variants and rejects claims/names/statistics',()=>{
 const {fallback,...variants}=copy;assert.deepEqual(parseMarketing(response(variants)),variants);
 for(const text of ['What about Acme hiring 100 reps?','Consider the guaranteed salary.','ROOK offers automatic applications.','Which salary is best?'])assert.throws(()=>validateText(text));
});
test('recent-post protection catches overlap beyond exact strings',()=>{
 assert.ok(similarity('Compare responsibilities and decisions in possible roles.','Consider comparing the decisions and responsibilities involved in a role.')>=0.65);
 const {fallback,...variants}=copy;assert.throws(()=>parseMarketing(response(variants),[copy.linkedin]),/repetitive/);
});
test('OpenAI generates new strings, receives recent history and uses the existing key',async()=>{
 const {fallback,...variants}=copy;let input;
 const result=await generateMarketing({theme:'industry',industry:'Medical Device',recent:['Earlier unrelated reflection.']},{env:{OPENAI_API_KEY:'fake'},fetchImpl:async(_,opts)=>{input=JSON.parse(opts.body);return {ok:true,json:async()=>response(variants)};}});
 assert.equal(result.fallback,false);assert.equal(input.store,false);assert.match(input.input,/Earlier unrelated/);assert.equal(result.linkedin,copy.linkedin);
});
test('OpenAI failure retries three times then retains deterministic fallback',async()=>{
 let calls=0;const result=await generateMarketing({theme:'education'},{env:{OPENAI_API_KEY:'fake'},fetchImpl:async()=>{calls++;throw Error('offline');}});
 assert.equal(calls,3);assert.equal(result.fallback,true);assert.ok(result.facebook);
});
test('channel UTM links are deterministic and Reddit remains generation-only',()=>{
 const slot={kind:'industry',industry:'Medical Device'};
 for(const channel of ['linkedin','facebook','reddit']){const text=regularPost(slot,channel,copy);assert.match(text,new RegExp('utm_source='+channel));assert.match(text,/utm_medium=social/);}
});
test('Buffer queue API follows pagination and uses live plan limit',async()=>{
 let page=0;const result=await readQueue('fake','org',{httpFetch:async()=>({ok:true,text:async()=>JSON.stringify({data:{account:{organizations:[{id:'org',limits:{scheduledPosts:10}}]},posts:{edges:[{node:{id:String(++page)}}],pageInfo:{hasNextPage:page===1,endCursor:'next'}}}})})});
 assert.equal(result.posts.length,2);assert.equal(result.limit,10);
});
test('disabled queue has no side effects',async()=>assert.equal((await replenish({automationEnabled:'false'})).stage,'disabled'));
test('full Buffer queue defers quietly without generating or publishing',async()=>{
 const posts=channels.flatMap(c=>Array.from({length:10},(_,i)=>({id:c.id+i,channelId:c.id,status:'scheduled',dueAt:'2031-01-01'})));
 const r=await replenish(config,deps({readQueue:async()=>({posts,limit:10}),generateMarketing:async()=>assert.fail('no space'),sendEmail:async()=>assert.fail('capacity is normal')}));
 assert.equal(r.ok,true);assert.equal(r.created,0);assert.ok(r.capacityDeferred>0);
});
test('regular posts fill only missing slots, keep existing content and respect capacity',async()=>{
 const slots=futureSlots(new Date('2030-06-01T00:00:00Z')),posts=[];
 for(const s of slots.filter(s=>['am','pm'].includes(s.slot)))for(const c of channels)posts.push({id:`job-${posts.length}`,channelId:c.id,status:'scheduled',dueAt:s.dueAt,text:'Existing job'});
 const existing=slots.find(s=>s.slot==='marketing-1');posts.push({id:'manual',channelId:'li',status:'scheduled',dueAt:existing.dueAt,text:'Keep this legitimate existing content'});
 let calls=0;
 const r=await replenish(config,deps({readQueue:async()=>({posts:[...posts],limit:10}),createPost:async(_,p)=>{const post={...p,id:`new-${++calls}`,status:'scheduled'};posts.push(post);return post;},runScheduledSlot:async()=>assert.fail('jobs already represented'),sendEmail:async()=>assert.fail('successful operation is silent')}));
 assert.equal(r.ok,true);assert.equal(posts.find(p=>p.id==='manual').text,'Keep this legitimate existing content');
 for(const c of channels)assert.equal(posts.filter(p=>p.channelId===c.id).length,10);
 assert.equal(r.created,11);assert.ok(r.generated>0);
});
test('unresolved Buffer send alerts after bounded recovery',async()=>{
 const db=memoryDb();db.rows.push({run_key:'old',channel_id:'li',state:'sending',payload:{text:'unknown',dueAt:'2030-06-01'}});let email;
 const r=await replenish(config,deps({supabaseAdmin:db,sendEmail:async e=>{email=e;}}));assert.equal(r.ok,false);assert.equal(email.to,'gzentko@gmail.com');assert.match(email.subject,/URGENT — ROOK/);
});
test('a matched ambiguous receipt is recovered without a duplicate mutation',async()=>{
 const db=memoryDb();const post={id:'accepted',channelId:'li',text:'known',dueAt:'2030-06-02',status:'scheduled'};
 db.rows.push({run_key:'old',channel_id:'li',state:'sending',payload:{text:'known',dueAt:post.dueAt}});
 const posts=[post,...channels.flatMap(c=>Array.from({length:10},(_,i)=>({id:c.id+i,channelId:c.id,status:'scheduled',dueAt:'2031-01-01'})))];
 await replenish(config,deps({supabaseAdmin:db,readQueue:async()=>({posts,limit:10})}));assert.equal(db.rows[0].state,'scheduled');assert.equal(db.rows[0].post.id,'accepted');
});
