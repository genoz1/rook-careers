// Read-only production authorization/schema check. Never emits a conversion.
require('dotenv').config({quiet:true});
const {createClient}=require('@supabase/supabase-js');
const {verifyAuthorization}=require('../linkedinPaidConversion');
(async()=>{
  const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
  const {error}=await db.from('ad_conversion_events').select('linkedin_invoice_id,linkedin_email_sha256,linkedin_sent_at').limit(0);
  if(error)throw Error('LinkedIn delivery-receipt migration is not verified');
  const result=await verifyAuthorization();
  console.log(JSON.stringify({...result,receiptSchemaVerified:true,conversionEventsSent:0}));
})().catch(()=>{console.error('LinkedIn paid-conversion verification failed; check server secret, schema, and account permissions. No conversion was sent.');process.exitCode=1;});
