// In-memory projection/filter adapter for deterministic matching replay tests.
function database(rows,{fail=false}={}){
  return {from(){let columns='*',filters=[],range=null;const q={
    select(c){columns=c;return q;},eq(k,v){filters.push(j=>j[k]===v);return q;},
    in(k,ids){filters.push(j=>ids.includes(j[k]));return q;},order(){return q;},
    range(a,b){range=[a,b];return q;},
    then(resolve,reject){
      if(fail&&range?.[0]===500)return Promise.resolve({error:{message:'unavailable'}}).then(resolve,reject);
      let data=rows.filter(j=>filters.every(f=>f(j))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      if(range)data=data.slice(range[0],range[1]+1);
      if(columns!=='*')data=data.map(j=>Object.fromEntries(columns.split(',').map(k=>k.trim()).filter(k=>k in j).map(k=>[k,j[k]])));
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }
  };return q;}};
}
module.exports={database};
