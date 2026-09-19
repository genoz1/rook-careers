// The API supplies only safe structured attributes. Placeholders contain no text.
(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.rookRenderMaskedJob = function (job) {
    const m=job.match || {};
    const qualified=Number.isFinite(m.candidate_fit);
    const score=qualified ? m.overall_score : m.preference_fit;
    const value=Number.isFinite(score) ? Math.max(0,Math.min(100,Math.round(score))) : null;
    const labels=(job.industry_classification?.labels || []).map(x=>x==='Veterinary'?'Veterinary / Animal Health':x);
    const facts=[job.role_type,...labels].filter(Boolean);
    const badge=m.excellent_match ? 'Excellent Match' : m.recommendation;
    const geography=job.territory_type || (Number.isFinite(job.distance_miles) ? `${job.distance_miles} miles away` : '');
    return `<article class="job-row masked-job" aria-label="Locked personalized opportunity">
      <div class="masked-facts"><div class="masked-placeholder" aria-hidden="true"><i></i><i></i></div>
        <div class="masked-tags">${badge?`<span class="rec-badge">${esc(badge)}</span>`:''}${facts.length?`<span>${facts.map(esc).join(' · ')}</span>`:''}</div>
        ${geography?`<p class="masked-distance">${esc(geography)}</p>`:''}
        <p class="masked-freshness">${esc(job.freshness_label || '')}</p>
        <div class="masked-lock"><span aria-hidden="true">🔒</span><div><strong>Job title and employer hidden</strong><p>Start your 3-day free trial to view the full opportunity details and apply directly.</p></div></div>
      </div>
      <div class="masked-actions"><div class="masked-score"><div class="score-ring" style="--pct:${value ?? 0}" aria-label="${qualified?'Match':'Preference Match'}: ${value==null?'not scored':value+'%'}"><span>${value==null?'—':value+'%'}</span></div><div><strong>${qualified?'Match Score':'Preference Match'}</strong><small>${qualified?'Qualifications and preferences scored':'Qualifications not scored yet'}</small></div></div>
      <button type="button" class="btn btn-primary" onclick="rookGoToCheckout('job_card')"><span aria-hidden="true">🔒</span> Unlock Job</button></div>
    </article>`;
  };
  window.rookApplyPretrialPresentation = function(profile,locked) {
    document.body.classList.toggle('rook-pretrial',locked);
    if(!locked){const newest=document.querySelector('#sortSelect option[value="newest"]');if(newest)newest.hidden=false;document.getElementById('maskedValueHeader')?.remove();if(typeof rookRestoreFullNavigation==='function')rookRestoreFullNavigation();return;}
    if(document.getElementById('maskedValueHeader')) return;
    const newest=document.querySelector('#sortSelect option[value="newest"]');if(newest)newest.hidden=true;
    const main=document.querySelector('main.main'); if(!main) return;
    const header=document.createElement('section');header.id='maskedValueHeader';header.className='masked-value';
    header.innerHTML='<div><h1>Personalized Opportunities for You</h1><p>These real opportunities match your onboarding preferences. Start your 3-day free trial to see full job titles, employers and apply directly.</p></div><ul><li>✓ Real job opportunities</li><li>✓ Personalized to your preferences</li><li>✓ Employers stay hidden until unlock</li></ul>';
    main.prepend(header);
    const banner=document.getElementById('unlockBanner');
    if(banner){banner.className='masked-cta';banner.removeAttribute('style');banner.innerHTML='<div><h2>Ready to see the full details?</h2><p>Unlock job titles, employers, complete opportunity details and direct applications.</p><small>3 days free, then $19.99/month. Cancel anytime.</small></div><button type="button" id="unlockBannerBtn" class="btn btn-primary" onclick="rookGoToCheckout(\'banner\')">Start 3-Day Free Trial</button>';main.append(banner);}
    if(typeof rookApplyLimitedNavigation==='function') rookApplyLimitedNavigation();
  };
})();
