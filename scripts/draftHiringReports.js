// Local files only. No database, API, AI, publishing or scheduler access.
const fs=require('node:fs'),path=require('node:path');
const {renderReports}=require('../backend/hiringIntelligence');
if(require.main===module){
 const [input,out]=process.argv.slice(2);if(!input||!out)throw Error('Usage: node scripts/draftHiringReports.js SNAPSHOT.json OUTPUT_DIRECTORY');
 const reports=renderReports(JSON.parse(fs.readFileSync(input,'utf8')));fs.mkdirSync(out,{recursive:true});
 for(const r of reports)fs.writeFileSync(path.join(out,r.slug+'.md'),r.markdown);
 console.log('Prepared '+reports.length+' local drafts. No publication or scheduling performed.');
}
