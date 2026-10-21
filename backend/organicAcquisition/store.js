'use strict';
class SupabaseAcquisitionStore {
 constructor(client) { this.client=client; }
 async call(op,a={}) { const {data,error}=await this.client.rpc('rook_acq_command',{op,a}); if(error)throw Error('Acquisition database operation failed'); return data; }
}
// Real embedded Postgres used in staging tests; same SQL/RPC logic, not a fake store.
class PostgresAcquisitionStore {
 constructor(db) { this.db=db; }
 async call(op,a={}) { const r=await this.db.query('select rook_acq_command($1,$2::jsonb) result',[op,JSON.stringify(a)]); return r.rows[0].result; }
}
module.exports={SupabaseAcquisitionStore,PostgresAcquisitionStore};
