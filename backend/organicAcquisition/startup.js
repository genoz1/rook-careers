'use strict';
function startSafely(env=process.env,{create=()=>require('./runtime').createRuntime(env),log=console.error}={}){
 if(env.ROOK_ACQUISITION_ENABLED!=='true')return null;
 try{return create();}catch{log('[acquisition] disabled: startup configuration failed; existing customer service remains available');return null;}
}
module.exports={startSafely};
