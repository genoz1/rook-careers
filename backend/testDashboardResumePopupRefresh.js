const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

for(const page of ['rook-dashboard.html','rook-dashboard-v7.html']){
  test(`${page} confirms résumé analysis and persisted rescore before reloading`,()=>{
    const html=fs.readFileSync(path.join(__dirname,'../public',page),'utf8');
    const uploadFlow=html.slice(html.indexOf("fileInput.onchange = async () =>"),html.indexOf("} else if (missingResume"));
    assert.notEqual(uploadFlow.length,0,'profile-gate upload handler exists');
    assert.match(uploadFlow,/analysis_status !== 'ok'/,'an unsuccessful analysis must not be reported as a completed refresh');
    assert.match(uploadFlow,/\/api\/resume-status/,'the dashboard checks the authenticated rescore status endpoint');
    assert.match(uploadFlow,/status === 'complete'/,'the dashboard waits for persisted scoring confirmation');
    assert.match(uploadFlow,/180000/,'polling ends with an honest timeout state');
    const confirmed=uploadFlow.indexOf("status === 'complete'");
    const reload=uploadFlow.indexOf('window.location.reload()');
    assert.ok(confirmed>=0 && reload>confirmed,'reload only occurs after the complete status branch');
    assert.match(uploadFlow,/not yet confirmed that the match refresh finished/,'timeout does not claim the matches were refreshed');
  });
}
