'use strict';
require('../backend/organicAcquisition/resendSimulatorCheck').verifySimulator({confirm:process.argv.includes('--confirm-resend-simulator')}).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('Resend simulator validation incomplete; provider bodies and credentials suppressed. Reconcile any accepted receipt before retrying.');process.exitCode=1;});
