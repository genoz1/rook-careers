// Two-day, six-slot replenishment. Reuses the original durable send ledger.
const { randomUUID } = require('crypto');
const { computeRunKey } = require('./socialAutomation');
const { getEasternParts } = require('./socialScheduler');
const { createPost, listAllChannels, readQueue, readRecentPosts } = require('./socialBuffer');
const { identifyRookChannels } = require('./socialChannels');
const { futureSlots, representedPost, availableCapacity, regularPost } = require('./socialContentPlan');
const { sendEmail } = require('./email/resend');
async function durableCreate(db, runKey, token, payload, send = createPost) {
  const table = () => db.from('social_queue_sends');
  const key = q => q.eq('run_key', runKey).eq('channel_id', payload.channelId);
  // Persist an intent BEFORE the external mutation. An ambiguous outcome is
  // deliberately not retried: Buffer has no idempotency key in this interface.
  const { error } = await table().insert({ run_key: runKey, channel_id: payload.channelId, state: 'sending', payload });
  if (error) {
    if (error.code !== '23505') throw Error('Cannot record Buffer send intent');
    const { data: prior, error: readError } = await key(table().select('*')).maybeSingle();
    if (readError || !prior) throw Error('Cannot read Buffer send receipt');
    if (prior.state === 'scheduled' && prior.post?.id) {
      if (String(prior.payload.photoUrl || '') !== String(payload.photoUrl || '') ||
          new Date(prior.payload.dueAt).getTime() !== new Date(payload.dueAt).getTime()) {
        throw Error('Accepted Buffer content changed; reconcile saved receipt');
      }
      return prior.post;
    }
    if (prior.state !== 'rejected') throw Error('Buffer outcome uncertain; reconcile saved intent before retry');
    const { data: claimed, error: claimError } = await key(table().update({ state: 'sending', payload })).eq('state', 'rejected').select('run_key');
    if (claimError || !claimed?.length) throw Error('Buffer send already claimed');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let post;
    try {
      post = await send(token, payload);
      if (!post?.id) throw Error('Buffer did not return a post receipt');
    } catch (err) {
      // Only an explicit MutationError proves Buffer rejected the mutation.
      // Network/HTTP/parse/timeouts remain 'sending' and require reconciliation.
      if (err.isMutationError && attempt < 2) continue;
      if (err.isMutationError) {
        const { error: saveError } = await key(table().update({ state: 'rejected' }));
        if (saveError) throw Error('Cannot save Buffer rejection');
      }
      throw err;
    }
    const { error: receiptError } = await key(table().update({ state: 'scheduled', post }));
    if (receiptError) throw Error('Buffer accepted post but receipt could not be saved; reconcile intent');
    return post;
  }
}

async function replenish(config, deps = {}) {
  if (String(config.automationEnabled).toLowerCase() !== 'true') return { ok: true, stage: 'disabled', note: 'no-op' };
  const now = deps.now || new Date(), day = getEasternParts(now).dateStr;
  const owner = randomUUID(), failures = [], outcomes = [];
  let db, locked = false, aiFallbacks = 0, capacityDeferred = 0, created = 0, generated = 0, limit;
  try {
    const { createClient } = require('@supabase/supabase-js');
    db = deps.supabaseAdmin || createClient(config.supabaseUrl, config.supabaseServiceRoleKey,
      { global: { fetch: (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }) } });
    const claim = await db.rpc('claim_social_queue', { lock_owner: owner });
    if (claim.error) throw Error('Cannot claim social queue lock');
    if (!claim.data) return { ok: true, stage: 'already_running' };
    locked = true;
    const discovered = await (deps.listAllChannels || listAllChannels)(config.bufferAccessToken);
    const identified = identifyRookChannels(discovered, config);
    if (!identified.ok) throw Error('ROOK channels could not be identified');
    const channels = [identified.linkedin, identified.facebook].map(c => discovered.find(raw => raw.id === c.id));
    if (!channels[0].organizationId || channels[0].organizationId !== channels[1].organizationId) throw Error('ROOK channels must share an organization');
    const org = channels[0].organizationId;
    const read = () => (deps.readQueue || readQueue)(config.bufferAccessToken, org);
    let queue = await read(); limit = queue.limit;
    const recentPosts = await (deps.readRecentPosts || readRecentPosts)(config.bufferAccessToken, org);
    const recent = [...queue.posts, ...recentPosts].filter(p => channels.some(c => c.id === p.channelId))
      .sort((a,b) => new Date(b.dueAt || b.sentAt) - new Date(a.dueAt || a.sentAt)).slice(0,24).map(p => p.text);
    const { data: intents, error: intentError } = await db.from('social_queue_sends').select('*').eq('state','sending');
    if (intentError) throw Error('Cannot read Buffer intents');
    for (const intent of intents || []) {
      const matches = queue.posts.filter(p => p.channelId === intent.channel_id && String(p.text).replace(/https?:\/\/\S+/g, "[link]").trim() === String(intent.payload.text).replace(/https?:\/\/\S+/g, "[link]").trim() &&
        new Date(p.dueAt).getTime() === new Date(intent.payload.dueAt).getTime());
      if (matches.length !== 1) throw Error('Uncertain Buffer send requires reconciliation');
      const { error } = await db.from('social_queue_sends').update({state:'scheduled',post:matches[0]}).eq('run_key',intent.run_key).eq('channel_id',intent.channel_id);
      if (error) throw Error('Cannot reconcile accepted Buffer receipt');
    }
    let fallbackCopy;
    const makeCopy = async context => {
      const result = fallbackCopy || await (deps.generateMarketing || require('./socialMarketingCopy').generateMarketing)({ ...context, recent });
      if (result.fallback) { if (result.unavailable) fallbackCopy = result; aiFallbacks++; } else generated++;
      for (const platform of ['linkedin','facebook']) if (result[platform]) recent.unshift(result[platform]);
      recent.splice(24);
      return result;
    };
    const runJob = deps.runScheduledSlot || require('./socialPublishWorker').runScheduledSlot;
    for (const slot of futureSlots(now)) {
      const renewal = await db.rpc('claim_social_queue', { lock_owner: owner });
      if (renewal.error || !renewal.data) throw Error('Lost social queue lock');
      queue = await read(); limit = queue.limit;
      const missing = channels.filter(c => !representedPost(queue.posts, c.id, slot));
      if (!missing.length) { outcomes.push({slot:slot.slot,date:slot.dateStr,state:'represented'}); continue; }
      const allowed = new Set(missing.filter(c => availableCapacity(queue.posts,c.id,limit)>0).map(c=>c.id));
      if (!allowed.size) { capacityDeferred += missing.length; continue; }
      const runKey = computeRunKey(slot.dateStr,slot.slot);
      const send = async (token,payload) => {
        // Refresh the actual queue immediately before every mutation. A human
        // can add posts between cycles; the numeric target is never capacity.
        const current = await read();
        const existing = representedPost(current.posts,payload.channelId,slot);
        if (existing) return existing;
        if (!availableCapacity(current.posts,payload.channelId,current.limit)) throw Object.assign(Error('Buffer capacity is full'),{capacity:true});
        if (new Date(payload.dueAt) <= new Date()) throw Error('Slot became due before enqueueing');
        const post = await durableCreate(db,runKey,token,payload,deps.createPost || createPost);
        created++; return post;
      };
      if (['am','pm'].includes(slot.slot)) {
        let result;
        for (let attempt=0;attempt<2;attempt++) {
          try {
            result = await runJob(slot.slot,slot.dateStr,config,{
              ...deps,supabaseAdmin:db,supabaseAnon:db,generateMarketing:makeCopy,
              channelAllowed:id => allowed.has(id) || Boolean(representedPost(queue.posts,id,slot)),
              verifyExistingRun:row => ['facebook','linkedin'].every(platform => queue.posts.some(p=>p.id===row[platform+'_buffer_post_id'])),
              createPost:send,
            });
          } catch (error) { result={ok:false,stage:error.message}; }
          if (result.ok || result.capacityDeferred) break;
        }
        if (!result.ok && !result.capacityDeferred) { failures.push({runKey,stage:result.stage || 'job_replenishment'}); break; }
        if (result.capacityDeferred) capacityDeferred++;
      } else {
        const copy = await makeCopy({theme:slot.kind,industry:slot.industry});
        for (const channel of missing) {
          if (!allowed.has(channel.id)) {capacityDeferred++;continue;}
          try {
            await send(config.bufferAccessToken,{channelId:channel.id,text:regularPost(slot,channel.service,copy),mode:'customScheduled',dueAt:slot.dueAt,
              ...(channel.service==='facebook'?{metadata:{facebook:{type:'post'}}}:{})});
          } catch (error) {
            if(error.capacity){capacityDeferred++;continue;}
            failures.push({runKey,stage:'marketing_replenishment'}); break;
          }
        }
        if(failures.length)break;
      }
      outcomes.push({slot:slot.slot,date:slot.dateStr,state:'processed'});
    }
  } catch (error) { failures.push({stage:error.message}); }
  finally {
    if(locked)try {
      const {error}=await db.from('social_queue_lock').update({owner:null,expires_at:null}).eq('id',1).eq('owner',owner);
      if(error)failures.push({stage:'lock_release'});
    }catch{failures.push({stage:'lock_release'});}
  }
  if(failures.length || aiFallbacks) await (deps.sendEmail || sendEmail)({to:'gzentko@gmail.com',subject:'URGENT — ROOK: Social queue needs attention',
    idempotencyKey:`rook-social-queue-${day}`,
    html:'<h1>URGENT — ROOK</h1><p>Social replenishment exhausted bounded recovery or fresh OpenAI copy is unavailable. Deterministic fallback is used where possible. Review the social worker logs and social_queue_sends. Uncertain sends require reconciliation; do not blindly resend. Normal Buffer capacity deferrals are not failures.</p>'});
  return {ok:!failures.length,created,generated,aiFallbacks,capacityDeferred,limit,outcomes,failures};
}
module.exports={futureSlots,durableCreate,replenish};
