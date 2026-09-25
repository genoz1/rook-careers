const path=require('path');
const crypto=require('crypto');
const {validateGraphicBuffer}=require('./socialGraphicStorage');
const {uploadGraphicToStorage}=require('./socialMediaStorage');
const {preflightCheckMedia}=require('./socialMediaPreflight');
const CATALOG=require('./socialApprovedCatalog.json');
async function renderBrandedCard(input){
 if(!CATALOG.some(x=>x.graphicId===input.graphicId))throw Error('Unknown approved social graphic');
 const buffer=await require('fs/promises').readFile(path.join(__dirname,'../public/assets/social-approved',input.graphicId+'.jpg'));
 await validateGraphicBuffer(buffer);return buffer;
}
async function prepareMarketingGraphic(db,slot,copy,deps={}) {
 const buffer=await (deps.renderBrandedCard || renderBrandedCard)({graphicId:copy.graphicId,label:copy.label,headline:copy.headline,points:copy.kind === 'value' ? copy.points?.slice(0,1) : copy.points,topicId:copy.topicId});
 await validateGraphicBuffer(buffer);
 const contentVersion=crypto.createHash('sha256').update(buffer).digest('hex').slice(0,20);
 const stored=await (deps.uploadGraphicToStorage || uploadGraphicToStorage)(db,{dateStr:slot.dateStr,slot:slot.slot,jobId:'editorial',contentVersion,buffer});
 const check=await (deps.preflightCheckMedia || preflightCheckMedia)(stored.publicUrl);
 if(!check.ok)throw Error(`Marketing media preflight: ${check.reason}`);
 return {photoUrl:stored.publicUrl,topicId:copy.topicId,contentVersion,bytes:buffer.length,mediaPreflight:check};
}
module.exports={renderBrandedCard,prepareMarketingGraphic};
