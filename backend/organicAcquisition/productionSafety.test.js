'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runCoordinateRepair}=require('../bootMaintenance');
const {loadConfig}=require('../socialPublishWorker');
test('normal web startup cannot repair or write job records',async()=>{let calls=0;const repair=async()=>{calls++;};for(const env of [{},{ROOK_RUN_BOOT_COORDINATE_REPAIR:'false'}])assert.equal((await runCoordinateRepair({}, {env,repair})).skipped,true);assert.equal(calls,0);});
test('coordinate maintenance requires a separate explicit opt in',async()=>{let calls=0;await runCoordinateRepair({}, {env:{ROOK_RUN_BOOT_COORDINATE_REPAIR:'true'},repair:async()=>{calls++;}});assert.equal(calls,1);});
test('legacy personal LinkedIn environment cannot re-enable personal publishing',()=>{for(const value of ['true','false',undefined]){const c=loadConfig({BUFFER_GENE_LINKEDIN_ENABLED:value,BUFFER_GENE_LINKEDIN_CHANNEL_ID:'personal'});assert.equal(c.personalLinkedinEnabled,false);assert.equal(c.personalLinkedinChannelId,null);}});
test('legacy job-card scheduler stays disabled to protect paid listing facts',()=>assert.equal(loadConfig({SOCIAL_AUTOMATION_ENABLED:'true'}).automationEnabled,'false'));
test('sidecar configuration failure cannot prevent customer service startup or expose secrets',()=>{const {startSafely}=require('./startup');let logs=[];assert.equal(startSafely({ROOK_ACQUISITION_ENABLED:'true'},{create:()=>{throw Error('secret-sentinel');},log:m=>logs.push(m)}),null);assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/secret-sentinel/);let called=false;assert.equal(startSafely({},{create:()=>{called=true;}}),null);assert.equal(called,false);});
