(function(){
 const toggle=document.querySelector('.menu-toggle'),nav=document.getElementById('resource-nav');
 if(toggle&&nav)toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));nav.classList.toggle('open',open);});
 const slug=document.body.dataset.resourceSlug;
 if(slug){try{sessionStorage.setItem('rook_resource_origin',slug);}catch{}if(typeof gtag==='function')gtag('event','resource_article_view',{resource_slug:slug});}
 document.addEventListener('click',e=>{const link=e.target.closest('[data-resource-event]');if(!link)return;
  if(typeof gtag==='function')gtag('event',link.dataset.resourceEvent,{resource_slug:slug||'resources'});
 });
})();
