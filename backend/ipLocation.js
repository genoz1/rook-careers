const net = require('node:net');
const geoip = require('geoip-lite');

function publicIp(value) {
  const ip=String(value||'').replace(/^::ffff:/,'').trim();
  if(!net.isIP(ip))return null;
  if(ip==='::1'||ip==='127.0.0.1'||ip.startsWith('10.')||ip.startsWith('192.168.')||ip.startsWith('169.254.'))return null;
  if(/^172\.(1[6-9]|2\d|3[01])\./.test(ip)||/^f[cd][0-9a-f]{2}:/i.test(ip)||/^fe80:/i.test(ip))return null;
  return ip;
}

function resolveIpLocation(value) {
  const ip=publicIp(value);
  if(!ip)return {location:null,reason:'no_public_ip'};
  const hit=geoip.lookup(ip);
  const lat=Number(hit?.ll?.[0]),lng=Number(hit?.ll?.[1]);
  const state=String(hit?.region||'').toUpperCase(),city=String(hit?.city||'').trim();
  if(hit?.country!=='US'||!Number.isFinite(lat)||!Number.isFinite(lng)||!/^[A-Z]{2}$/.test(state)||!city)
    return {location:null,reason:'location_unavailable'};
  return {location:{lat,lng,city,stateAbbr:state,state,zip:null,label:`${city}, ${state}`,approximate:true,provider:'local_geoip'}};
}

module.exports={resolveIpLocation,publicIp};
