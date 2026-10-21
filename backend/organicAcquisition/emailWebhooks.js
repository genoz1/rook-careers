'use strict';
const express=require('express'),crypto=require('node:crypto');
const {equal}=require('./security');
function verify(raw,headers,secret,now=Date.now()){
 const id=headers['svix-id'],ts=headers['svix-timestamp'],signatures=headers['svix-signature'];
 if(!secret?.startsWith('whsec_')||!id||!/^\d+$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300||typeof signatures!=='string')throw Error('Invalid email webhook');
 const key=Buffer.from(secret.slice(6),'base64');if(key.length<16)throw Error('Invalid email webhook secret');
 const expected=crypto.createHmac('sha256',key).update(id+'.'+ts+'.'+raw.toString('utf8')).digest('base64');
 if(!signatures.split(' ').some(part=>part.startsWith('v1,')&&equal(part.slice(3),expected)))throw Error('Invalid email signature');
 return JSON.parse(raw.toString('utf8'));
}
function createEmailWebhooks({store,signer,secret,replyAddress,clock=Date.now}){
 const router=express.Router();
 router.post('/api/acquisition/email-webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
  let event;try{event=verify(req.body,req.headers,secret,clock());}catch{return res.status(400).json({received:false});}
  try{
   if(['email.bounced','email.complained','email.received'].includes(event.type)){
    const data=event.data||{};let addresses=[];
    if(event.type==='email.received'){
     const to=Array.isArray(data.to)?data.to:[];
     if(replyAddress&&to.some(a=>String(a).toLowerCase()===replyAddress.toLowerCase()))addresses=[String(data.from||'').replace(/^.*<([^>]+)>.*$/,'$1')];
    }else addresses=Array.isArray(data.to)?data.to:[];
    const partners=await store.call('list',{kind:'partner'});
    for(const email of addresses){const hash=signer.identity(email);if(!partners.some(p=>p.body.identityHash===hash))continue;await store.call('put',{kind:'suppression',id:hash,body:{reason:event.type,at:new Date(clock()).toISOString()}});}
   }
   res.json({received:true});
  }catch{res.status(503).json({received:false});}
 });return router;
}
module.exports={verify,createEmailWebhooks};
