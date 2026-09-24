// Two-day, six-slot replenishment. Reuses the original durable send ledger.
const { randomUUID } = require('crypto');
const { computeRunKey } = require('./socialAutomation');
const { getEasternParts } = require('./socialScheduler');
const { createPost, listAllChannels, readQueue, readRecentPosts } = require('./socialBuffer');
const { identifyRookChannels, identifyOptionalPersonalLinkedin } = require('./socialChannels');
const { PERSONAL_COPY_TOKEN, futureSlots, representedPost, availableCapacity, isPersonalLinkedinSlot, personalLinkedinSlot, regularPost } = require('./socialContentPlan');
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
  const personalFailures = [], personalOutcomes = [];
  let db, locked = false, aiFallbacks = 0, capacityDeferred = 0, created = 0, generated = 0, limit;
  const aiFallbackDetails = [];
  let personalCreated = 0, personalDeferred = 0;
  let personalChannel = null, personalIntents = [], queue, recentPosts, channels, org, read;
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
    channels = [identified.linkedin, identified.facebook].map(c => discovered.find(raw => raw.id === c.id));
    if (!channels[0].organizationId || channels[0].organizationId !== channels[1].organizationId) throw Error('ROOK channels must share an organization');
    org = channels[0].organizationId;
    read = () => (deps.readQueue || readQueue)(config.bufferAccessToken, org);
    queue = await read(); limit = queue.limit;
    recentPosts = await (deps.readRecentPosts || readRecentPosts)(config.bufferAccessToken, org);
    const recent = [...queue.posts, ...recentPosts].filter(p => channels.some(c => c.id === p.channelId))
      .sort((a,b) => new Date(b.dueAt || b.sentAt) - new Date(a.dueAt || a.sentAt)).slice(0,24).map(p => p.text);
    const optional = identifyOptionalPersonalLinkedin(discovered, config.personalLinkedinChannelId, channels.map(c => c.id));
    if (optional.ok && optional.channel.organizationId === org) personalChannel = discovered.find(c => c.id === optional.channel.id);
    else personalFailures.push({ stage: 'channel_identification', reason: optional.ok ? 'Gene LinkedIn must share the Buffer organization' : optional.error });
    const { data: intents, error: intentError } = await db.from('social_queue_sends').select('*').eq('state','sending');
    if (intentError) throw Error('Cannot read Buffer intents');
    for (const intent of intents || []) {
      if (!channels.some(channel => channel.id === intent.channel_id)) { personalIntents.push(intent); continue; }
      const matches = queue.posts.filter(p => p.channelId === intent.channel_id && String(p.text).replace(/https?:\/\/\S+/g, "[link]").trim() === String(intent.payload.text).replace(/https?:\/\/\S+/g, "[link]").trim() &&
        new Date(p.dueAt).getTime() === new Date(intent.payload.dueAt).getTime());
      if (matches.length !== 1) throw Error('Uncertain Buffer send requires reconciliation');
      const { error } = await db.from('social_queue_sends').update({state:'scheduled',post:matches[0]}).eq('run_key',intent.run_key).eq('channel_id',intent.channel_id);
      if (error) throw Error('Cannot reconcile accepted Buffer receipt');
    }
    let fallbackCopy;
    const makeCopy = async context => {
      const result = fallbackCopy || await (deps.generateMarketing || require('./socialMarketingCopy').generateMarketing)({ ...context, recent });
      if (result.fallback) {
        if (result.unavailable) fallbackCopy = result;
        aiFallbacks++;
        const detail = { slot: context.slot || context.theme || 'unknown', industry: context.category || context.industry || null,
          reason: result.reason || 'unspecified', unavailable: Boolean(result.unavailable), model: result.model || null };
        aiFallbackDetails.push(detail);
        console.warn(`[social-copy-fallback] ${JSON.stringify(detail)}`);
      } else generated++;
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
              ...(channel.id===channels[0].id?{personalTemplate:regularPost(slot,'linkedin',{linkedin:PERSONAL_COPY_TOKEN})}:{}),
              ...(channel.service==='facebook'?{metadata:{facebook:{type:'post'}}}:{})});
          } catch (error) {
            if(error.capacity){capacityDeferred++;continue;}
            failures.push({runKey,stage:'marketing_replenishment',reason:error.message}); break;
          }
        }
        if(failures.length)break;
      }
      outcomes.push({slot:slot.slot,date:slot.dateStr,state:'processed'});
    }

    // Optional downstream phase. The company loop above is complete before
    // any Gene-specific validation, generation or Buffer mutation can fail.
    if (!failures.length && personalChannel) {
      try {
        queue = await read();
        for (const intent of personalIntents) {
          const matches = queue.posts.filter(p => p.channelId === intent.channel_id && String(p.text).replace(/https?:\/\/\S+/g, "[link]").trim() === String(intent.payload.text).replace(/https?:\/\/\S+/g, "[link]").trim() &&
            new Date(p.dueAt).getTime() === new Date(intent.payload.dueAt).getTime());
          if (matches.length !== 1) throw Error('Gene LinkedIn send requires reconciliation');
          const { error } = await db.from('social_queue_sends').update({state:'scheduled',post:matches[0]}).eq('run_key',intent.run_key).eq('channel_id',intent.channel_id);
          if (error) throw Error('Cannot reconcile Gene LinkedIn receipt');
        }
        const personalRecent = [...queue.posts, ...recentPosts].filter(p => p.channelId === personalChannel.id)
          .sort((a,b) => new Date(b.dueAt || b.sentAt) - new Date(a.dueAt || a.sentAt)).slice(0,36).map(p => p.text);
        const generatePersonal = deps.generatePersonalLinkedin || require('./socialMarketingCopy').generatePersonalLinkedin;
        for (const slot of futureSlots(now).filter(isPersonalLinkedinSlot)) {
          const renewal = await db.rpc('claim_social_queue', { lock_owner: owner });
          if (renewal.error || !renewal.data) throw Error('Lost social queue lock during Gene phase');
          const target = personalLinkedinSlot(slot), runKey = computeRunKey(slot.dateStr,slot.slot);
          queue = await read();
          if (representedPost(queue.posts,personalChannel.id,target)) { personalOutcomes.push({slot:slot.slot,date:slot.dateStr,state:'represented'}); continue; }
          if (!availableCapacity(queue.posts,personalChannel.id,queue.limit)) { personalDeferred++; personalOutcomes.push({slot:slot.slot,date:slot.dateStr,state:'capacity_deferred'}); continue; }
          const { data: source, error: sourceError } = await db.from('social_queue_sends').select('*')
            .eq('run_key',runKey).eq('channel_id',channels[0].id).maybeSingle();
          if (sourceError) throw Error('Cannot read company LinkedIn source receipt for Gene');
          if (!source?.payload?.personalTemplate || !source.payload.personalTemplate.includes(PERSONAL_COPY_TOKEN)) {
            personalDeferred++; personalOutcomes.push({slot:slot.slot,date:slot.dateStr,state:'source_pending'}); continue;
          }
          const generated = await generatePersonal({theme:slot.kind,slot:slot.slot,industry:slot.industry,recent:[source.payload.text,...personalRecent]});
          const text = source.payload.personalTemplate.replace(PERSONAL_COPY_TOKEN,generated.text);
          const current = await read();
          if (representedPost(current.posts,personalChannel.id,target)) continue;
          if (!availableCapacity(current.posts,personalChannel.id,current.limit)) { personalDeferred++; continue; }
          if (target.dueAt <= new Date()) { personalDeferred++; continue; }
          await durableCreate(db,runKey,config.bufferAccessToken,{channelId:personalChannel.id,text,photoUrl:source.payload.photoUrl,mode:'customScheduled',dueAt:target.dueAt},deps.createPost || createPost);
          personalCreated++; personalRecent.unshift(text); personalRecent.splice(36);
          personalOutcomes.push({slot:slot.slot,date:slot.dateStr,state:'scheduled'});
        }
      } catch (error) { personalFailures.push({stage:'gene_linkedin',reason:error.message}); }
    }
  } catch (error) { failures.push({stage:error.message}); }
  finally {
    if(locked)try {
      const {error}=await db.from('social_queue_lock').update({owner:null,expires_at:null}).eq('id',1).eq('owner',owner);
      if(error)failures.push({stage:'lock_release'});
    }catch{failures.push({stage:'lock_release'});}
  }
  const unavailableCopy = aiFallbackDetails.some(detail => detail.unavailable);
  if(failures.length || unavailableCopy) await (deps.sendEmail || sendEmail)({to:'gzentko@gmail.com',subject:'URGENT — ROOK: Social queue needs attention',
    idempotencyKey:`rook-social-queue-${day}`,
    html:'<h1>URGENT — ROOK</h1><p>Social replenishment exhausted bounded recovery or fresh OpenAI copy is unavailable. Deterministic fallback is used where possible. Review the social worker logs and social_queue_sends. Uncertain sends require reconciliation; do not blindly resend. Normal Buffer capacity deferrals are not failures.</p>'});
  if(personalFailures.length) try {
    await (deps.sendEmail || sendEmail)({to:'gzentko@gmail.com',subject:'ROOK: Gene LinkedIn distribution needs attention',idempotencyKey:`rook-gene-linkedin-${day}`,
      html:'<h1>Gene LinkedIn distribution deferred</h1><p>The ROOK company LinkedIn and Facebook pipeline completed independently. Review the Gene Buffer destination, personal-copy generation, or personal send ledger before retrying.</p>'});
  } catch (error) { console.error(`[Gene LinkedIn] alert failed: ${error.message}`); }
  return {ok:!failures.length,created,generated,aiFallbacks,aiFallbackDetails,capacityDeferred,limit,outcomes,failures,
    personal:{enabled:Boolean(personalChannel),created:personalCreated,deferred:personalDeferred,outcomes:personalOutcomes,failures:personalFailures}};
}
module.exports={futureSlots,durableCreate,replenish};
