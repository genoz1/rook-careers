const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

for(const page of ['rook-dashboard.html','rook-dashboard-v7.html','rook-dashboard-v8.html']){
  test(`${page} returns to the dashboard after résumé analysis without waiting on inventory rescore`,()=>{
    const html=fs.readFileSync(path.join(__dirname,'../public',page),'utf8');
    const start=html.indexOf("fileInput.onchange = async () =>");
    assert.ok(start>=0,'profile-gate upload handler exists');
    // V8 ends the upload block before activating the overlay; older dashboards
    // still use the missingResume/missingLocation branch marker.
    const endMarker=html.includes("} else if (missingResume")
      ? "} else if (missingResume"
      : "const gate = document.getElementById('profileGateOverlay')";
    const end=html.indexOf(endMarker, start);
    assert.ok(end>start,'upload handler end marker found');
    const uploadFlow=html.slice(start,end);
    assert.match(uploadFlow,/analysis_status !== 'ok'/,'an unsuccessful analysis must not claim success');
    assert.doesNotMatch(uploadFlow,/fetch\(['"]\/api\/resume-status['"]/,'do not block the member on background inventory rescore');
    assert.doesNotMatch(uploadFlow,/180000/,'do not poll for three minutes after analysis');
    const analyzed=uploadFlow.indexOf("analysis_status !== 'ok'");
    const reload=uploadFlow.indexOf('window.location.reload()');
    assert.ok(analyzed>=0 && reload>analyzed,'reload happens in the successful upload path');
    assert.match(uploadFlow,/Reloading your matches/,'success state tells the member they are returning to matches');
  });
}
