(function(){
 const toggle=document.querySelector('.menu-toggle'),nav=document.getElementById('resource-nav');
 if(toggle&&nav)toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));nav.classList.toggle('open',open);});
 const slug=document.body.dataset.resourceSlug;
 if(slug){try{sessionStorage.setItem('rook_resource_origin',slug);}catch{}if(typeof gtag==='function')gtag('event','resource_article_view',{resource_slug:slug});}
 document.addEventListener('click',e=>{const link=e.target.closest('[data-resource-event]');if(!link)return;
  if(typeof gtag==='function')gtag('event',link.dataset.resourceEvent,{resource_slug:slug||'resources'});
 });

 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function onboardingHref(source,content){
  const params=new URLSearchParams({utm_source:source||'resources',utm_medium:'article',utm_campaign:'open_roles',utm_content:String(content||'article').slice(0,80)});
  return '/rook-onboarding-v8.html?'+params.toString();
 }
 function rankJobs(jobs,prefer){
  if(!prefer)return jobs.slice();
  const hit=[],miss=[];
  for(const job of jobs){
   if((job.industry_labels||[]).some(label=>label===prefer))hit.push(job);
   else miss.push(job);
  }
  return hit.concat(miss);
 }
 function renderJobs(mount,jobs){
  const list=mount.querySelector('[data-article-jobs-list]');
  if(!list)return;
  const source=mount.dataset.jobsSource||'resources';
  const content=mount.dataset.jobsContent||'article';
  const path=mount.dataset.jobsPath||'/jobs';
  const href=onboardingHref(source,content+'-card');
  if(!jobs.length){
   list.innerHTML='<p class="article-jobs-empty">Current openings refresh throughout the day.</p><a class="article-jobs-fallback" data-resource-event="resource_job_click" href="'+esc(path)+'">Browse current job previews →</a>';
   return;
  }
  list.innerHTML=jobs.map(job=>{
   const title=job.role_title||'Sales opportunity';
   const loc=job.location_label||'United States';
   const specialty=job.specialty_label||(job.industry_labels&&job.industry_labels[0])||'Medical & veterinary sales';
   const fresh=job.freshness_label||'Open role';
   return '<a class="article-job-card" data-resource-event="resource_job_click" href="'+esc(href)+'">'+
     '<strong>'+esc(title)+'</strong>'+
     '<small>'+esc(loc)+' · '+esc(specialty)+'</small>'+
     '<span>'+esc(fresh)+' · Unlock employer &amp; apply →</span>'+
   '</a>';
  }).join('');
 }
 async function loadArticleJobs(){
  const mounts=[...document.querySelectorAll('[data-article-jobs]')];
  if(!mounts.length)return;
  const prefer=mounts[0].dataset.jobsPrefer||'';
  try{
   const res=await fetch('/api/public-featured-jobs',{credentials:'same-origin'});
   const data=await res.json().catch(()=>({}));
   if(!res.ok)throw new Error(data.error||('API '+res.status));
   const jobs=rankJobs(data.jobs||[],prefer).slice(0,4);
   for(const mount of mounts)renderJobs(mount,jobs);
   if(typeof gtag==='function')gtag('event','article_open_roles_view',{resource_slug:slug||mounts[0].dataset.jobsContent||'article',job_count:jobs.length});
  }catch(err){
   console.error('Could not load article open roles:',err);
  }
 }
 loadArticleJobs();
})();
