'use strict';
// Maintenance is deliberately separate from normal ingestion and web startup.
async function runCoordinateRepair(client,{env=process.env,repair}={}) {
 if (env.ROOK_RUN_BOOT_COORDINATE_REPAIR !== 'true') return {skipped:true,reason:'explicit_maintenance_opt_in_required'};
 return (repair || require('./repairCitySuffixCoordinates').repairCitySuffixCoordinates)(client);
}
module.exports={runCoordinateRepair};
