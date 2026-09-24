// Best-effort, process-local, industry-only candidate retrieval. No answers,
// unmasked jobs or scores leave the server. A missing/expired preparation
// always falls back to the unchanged query; no database migration is needed.
const crypto = require('node:crypto');
function createPreparation({readCandidates, now=Date.now, ttl=90000, maxEntries=8, maxBytes=32*1024*1024}) {
  const entries=new Map();
  let bytes=0;
  function remove(key) {const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}}
  function prune() {for(const [key,e] of entries)if(e.expires<=now())remove(key);}
  function start(db, industry) {
    prune();
    if(entries.size>=maxEntries)return null;
    const token=crypto.randomBytes(32).toString('hex');
    const entry={industry,expires:now()+ttl,bytes:0};
    entries.set(token,entry);
    entry.promise=Promise.resolve().then(()=>readCandidates(db,[industry])).then(jobs=>{
      // Expired/consumed/evicted work cannot repopulate the cache.
      if(entries.get(token)!==entry)return null;
      const size=Buffer.byteLength(JSON.stringify(jobs));
      if(bytes+size>maxBytes){remove(token);return null;}
      bytes+=size;entry.bytes=size;return jobs;
    }).catch(()=>{remove(token);return null;});
    return token;
  }
  async function take(token,industry) {
    prune();const entry=entries.get(token);
    if(!entry || entry.industry!==industry)return null;
    const jobs=await entry.promise;
    const valid=entries.get(token)===entry && entry.expires>now();
    remove(token);return valid?jobs:null;
  }
  return {start,take};
}
module.exports={createPreparation};
