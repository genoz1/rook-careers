'use strict';
const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function signer(secret){
 if(!secret||secret.length<32)throw Error('Acquisition signing secret must be at least 32 characters');
 return {
  sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');},
  read(token,now=Date.now()){if(typeof token!=='string'||token.length>2048)return null;const [body,sig,...extra]=token.split('.');if(extra.length||!equal(sig,crypto.createHmac('sha256',secret).update(body||'').digest('base64url')))return null;try{const p=JSON.parse(Buffer.from(body,'base64url').toString());return Number.isFinite(p.exp)&&p.exp>now?p:null;}catch{return null;}},
  identity(email){return crypto.createHmac('sha256',secret).update('email:'+String(email).trim().toLowerCase()).digest('hex');},
 };
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(x=>x.length===2));}
module.exports={digest,equal,signer,escape,cookies};
