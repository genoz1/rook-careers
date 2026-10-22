'use strict';
require('dotenv').config();
require('../backend/organicAcquisition/bufferDraftCheck').verifyDrafts({token:process.env.BUFFER_ACCESS_TOKEN,linkedinChannelId:process.env.BUFFER_ROOK_LINKEDIN_CHANNEL_ID,facebookChannelId:process.env.BUFFER_ROOK_FACEBOOK_CHANNEL_ID,confirm:process.argv.includes('--confirm-nonpublic-drafts')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(()=>{console.error('Nonpublic Buffer integration check unavailable or failed; real account validation remains incomplete.');process.exitCode=1;});
