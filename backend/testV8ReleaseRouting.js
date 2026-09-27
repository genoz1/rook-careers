const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'public', file), 'utf8');
function element(tag = 'input') {
  const handlers = {}, attrs = {};
  const el = {tagName:tag, value:'', hidden:true, children:[], style:{}, classList:{toggle(){}},
    setAttribute(k,v){attrs[k]=v}, removeAttribute(k){delete attrs[k]},
    addEventListener(k,fn){handlers[k]=fn}, dispatch(k,event={}){handlers[k]?.({preventDefault(){},stopPropagation(){},target:el,...event})},
    appendChild(child){this.children.push(child)}, querySelectorAll(){return this.children},
    contains(node){return node===this||this.children.includes(node)}, scrollIntoView(){}};
  Object.defineProperty(el,'innerHTML',{set(){el.children=[]}});
  return el;
}
(async()=>{
  const input=element(), list=element('ul'), status=element('div');let selected=null;
  const documentHandlers={};
  const context={window:{},document:{createElement:element,addEventListener(k,fn){documentHandlers[k]=fn}},
    fetch:async()=>({ok:true,json:async()=>[{label:'Tallahassee, FL',city:'Tallahassee',state:'Florida',lat:30.44,lng:-84.28}]}),
    setTimeout,clearTimeout,console};
  vm.runInNewContext(read('rook-location-widget-v8.js'),context);
  context.window.RookLocationWidget.init({inputEl:input,listEl:list,statusEl:status,onSelect:s=>{selected=s},onClear:()=>{selected=null}});
  async function suggest(){input.value='Tallahassee';input.dispatch('input');await new Promise(r=>setTimeout(r,380));assert.equal(list.children.length,1)}
  await suggest();let item=list.children[0];item.dispatch('pointerdown',{pointerType:'mouse'});item.dispatch('click');
  assert.equal(selected.city,'Tallahassee');assert.equal(input.value,selected.label);assert.equal(list.hidden,true);
  await suggest();item=list.children[0];item.dispatch('pointerdown',{pointerType:'touch'});item.dispatch('pointerup',{pointerType:'touch'});item.dispatch('click');
  assert.equal(selected.city,'Tallahassee');assert.equal(list.hidden,true);
  await suggest();input.dispatch('keydown',{key:'ArrowDown'});input.dispatch('keydown',{key:'Enter'});
  assert.equal(selected.city,'Tallahassee');assert.equal(list.hidden,true);
  await suggest();item=list.children[0];item.dispatch('click');
  assert.equal(selected.city,'Tallahassee');
  assert.match(read('rook-v8.css'),/\.modal \.location-field\{z-index:3\}/);
  assert.match(read('rook-onboarding-v8.html'),/rook-location-widget-v8\.js/);
  assert.doesNotMatch(read('rook-onboarding-v7.html'),/rook-location-widget-v8/);
  const links=['rook-dashboard.html','rook-settings.html?section=subscription','rook-job-analysis.html?job=123','rook-onboarding-v2.html?ob=resume_upload'].map(href=>({href,getAttribute(){return href},set href(v){this._href=v},get href(){return this._href||href}}));
  const handlers={},document={readyState:'complete',querySelectorAll:()=>links,addEventListener(k,fn){handlers[k]=fn}};
  vm.runInNewContext(read('rook-v8-context.js'),{window:{},document,location:{search:'?rook_v8=1',href:'https://rookcareers.com/rook-saved.html?rook_v8=1',origin:'https://rookcareers.com'},URL,URLSearchParams});
  assert.equal(links[0].href,'/rook-dashboard-v8.html');
  assert.equal(links[1].href,'/rook-settings.html?section=subscription&rook_v8=1');
  assert.equal(links[2].href,'/rook-job-analysis-v8.html?job=123');
  assert.equal(links[3].href,'/rook-resume.html?rook_v8=1');
  const untouched={href:'rook-dashboard.html',getAttribute(){return this.href}};
  vm.runInNewContext(read('rook-v8-context.js'),{window:{},document:{readyState:'complete',querySelectorAll:()=>[untouched],addEventListener(){}},location:{search:'',href:'https://rookcareers.com/rook-saved.html',origin:'https://rookcareers.com'},URL,URLSearchParams});
  assert.equal(untouched.href,'rook-dashboard.html');
  for(const file of ['rook-search.html','rook-saved.html','rook-tracker.html','rook-settings.html','rook-resume.html','rook-intelligence.html','rook-recruiter-jobs.html','rook-apply.html','rook-mobile-menu.html'])assert.match(read(file),/rook-v8-context\.js/);
  assert.match(read('rook-auth-v8.js'),/window\.location\.href = 'rook-checkout-v8\.html'/);
  assert.match(read('rook-access-context.js'),/v8Context\?'rook-dashboard-v8\.html'/);
  assert.match(read('rook-auth-v8.js'),/profile \? 'rook-dashboard-v8\.html' : 'rook-onboarding-v8\.html'/);
  for (const file of ['index.html','rook-about.html','rook-pricing.html','rook-browse.html','rook-companies.html','rook-mobile-menu.html']) {
    assert.match(read(file),/rook-onboarding-v8\.html/, file);
    assert.doesNotMatch(read(file),/rook-onboarding-v[27]\.html/, file);
  }
  assert.match(fs.readFileSync(path.join(root,'backend/resources/views.js'),'utf8'),/href="\/rook-onboarding-v8\.html"/);
  assert.match(fs.readFileSync(path.join(root,'backend/seoCollections.js'),'utf8'),/href="\/rook-onboarding-v8\.html"/);
  assert.match(fs.readFileSync(path.join(root,'backend/routes/publicPages.js'),'utf8'),/href="\/rook-onboarding-v8\.html/);

  console.log('PASS V8 pointer, touch, keyboard selection; suggestion layer; contextual routes; V7 isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
