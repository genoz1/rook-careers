// The API supplies only safe structured attributes and server-generated masks.
(function () {
  const isV7 = () => typeof document !== 'undefined' && document.body?.dataset?.v7Conversion === 'true';
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const maskedWords = (words,className) => {
    if(!Array.isArray(words) || words.length<2 || words.length>3 || words.some(word=>typeof word!=='string' || !/^[a-z]{4,9}$/.test(word))) return '';
    return `<span class="${className}" aria-hidden="true">${words.map(esc).join(' ')}</span>`;
  };
  window.rookRenderMaskedJob = function (job) {
    const m=job.match || {};
    const qualified=Number.isFinite(m.candidate_fit);
    const score=qualified ? m.overall_score : m.preference_fit;
    const value=Number.isFinite(score) ? Math.max(0,Math.min(100,Math.round(score))) : null;
    const labels=(job.industry_classification?.labels || []).map(x=>x==='Veterinary'?'Veterinary / Animal Health':x);
    const facts=(isV7()?[...labels,job.specialty_label]:[job.role_type,...labels]).filter((value,index,all)=>value && all.indexOf(value)===index);
    const role=isV7()?job.role_type || '':'';
    const badge=m.excellent_match ? 'Excellent Match' : m.recommendation;
    const geography=job.territory_type || (Number.isFinite(job.distance_miles) ? `${job.distance_miles} miles away` : '');
    if(isV7()) {
      const safeLabels=(job.industry_classification?.labels || []).filter((value,index,all)=>value && all.indexOf(value)===index);
      const cardFacts=[...safeLabels,job.specialty_label].filter((value,index,all)=>value && all.indexOf(value)===index);
      const freshness=job.freshness_label || '';
      const separator=geography&&freshness?'<span class="masked-meta-divider" aria-hidden="true"></span>':'';
      return `<article class="job-row masked-job masked-job-v7" aria-label="Locked personalized opportunity">
        <div class="masked-v7-primary">
          <div class="masked-v7-copy">${badge?`<span class="rec-badge">${esc(badge)}</span>`:''}<strong class="masked-role">${esc(role || 'Sales Opportunity')}</strong>${maskedWords(job.masked_lines?.title,'masked-title-fragment')}${cardFacts.length?`<div class="masked-v7-industries">${cardFacts.map(esc).join(' · ')}</div>`:''}</div>
          <div class="masked-v7-score"><div class="score-ring" style="--pct:${value ?? 0}" aria-label="Preference Match: ${value==null?'not scored':value+'%'}"><span>${value==null?'—':value+'%'}</span></div><strong>Preference Match</strong></div>
        </div>
        <div class="masked-v7-meta">${geography?`<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>${esc(geography)}</span>`:''}${separator}${freshness?`<span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h2m3 0h2m-7 4h2"/></svg>${esc(freshness)}</span>`:''}</div>
        <div class="masked-v7-bottom"><div class="masked-v7-employer"><span class="masked-v7-lock" aria-hidden="true">🔒</span><strong>Employer:</strong>${maskedWords(job.masked_lines?.employer,'masked-employer-fragment')}</div><button type="button" class="btn btn-primary masked-v7-cta" onclick="rookGoToCheckout('job_card')"><span aria-hidden="true">🔒</span> Unlock full details — 3 days free</button></div>
      </article>`;
    }
    return `<article class="job-row masked-job" aria-label="Locked personalized opportunity">
      <div class="masked-facts">${role?`<strong class="masked-role">${esc(role)}</strong>${maskedLines(job.masked_lines)}`:'<div class="masked-placeholder" aria-hidden="true"><i></i><i></i></div>'}
        <div class="masked-tags">${badge?`<span class="rec-badge">${esc(badge)}</span>`:''}${facts.length?`<span>${facts.map(esc).join(' · ')}</span>`:''}</div>
        ${geography?`<p class="masked-distance">${esc(geography)}</p>`:''}
        <p class="masked-freshness">${esc(job.freshness_label || '')}</p>
        <div class="masked-lock"><span aria-hidden="true">🔒</span><div><strong>${isV7()?'Company &amp; full job details hidden':'Job title and employer hidden'}</strong><p>Start your 3-day free trial to view the full opportunity details and apply directly.</p></div></div>
      </div>
      <div class="masked-actions"><div class="masked-score"><div class="score-ring" style="--pct:${value ?? 0}" aria-label="${qualified?'Match':'Preference Match'}: ${value==null?'not scored':value+'%'}"><span>${value==null?'—':value+'%'}</span></div><div><strong>${qualified?'Match Score':'Preference Match'}</strong><small>${qualified?'Qualifications and preferences scored':'Qualifications not scored yet'}</small></div></div>
      <button type="button" class="btn btn-primary" onclick="rookGoToCheckout('job_card')"><span aria-hidden="true">🔒</span> ${isV7()?'Unlock my matches — 3 days free':'Unlock Job'}</button></div>
    </article>`;
  };
  window.rookUpdateV7MatchCount = function(count) {
    if(!isV7() || !Number.isInteger(count) || count < 0) return;
    const heading=document.getElementById('v7MatchCount');
    if(heading) heading.textContent=count===0?'No matches for these selections':`${count} matching ${count===1?'opportunity':'opportunities'}`;
  };
  window.rookApplyPretrialPresentation = function(profile,locked) {
    document.body.classList.toggle('rook-pretrial',locked);
    if(!locked){const newest=document.querySelector('#sortSelect option[value="newest"]');if(newest)newest.hidden=false;document.getElementById('maskedValueHeader')?.remove();if(typeof rookRestoreFullNavigation==='function')rookRestoreFullNavigation();return;}
    if(document.getElementById('maskedValueHeader')) return;
    const newest=document.querySelector('#sortSelect option[value="newest"]');if(newest)newest.hidden=true;
    const main=document.querySelector('main.main'); if(!main) return;
    const header=document.createElement('section');header.id='maskedValueHeader';header.className='masked-value';
    header.innerHTML='<div><h1>Personalized Opportunities for You</h1><p>These real opportunities match your onboarding preferences. Start your 3-day free trial to see full job titles, employers and apply directly.</p></div><ul><li>✓ Real job opportunities</li><li>✓ Personalized to your preferences</li><li>✓ Employers stay hidden until unlock</li></ul>';
    if(isV7()) header.innerHTML='<div><h1 id="v7MatchCount" aria-live="polite">Your personalized matches</h1><p>Based on your answers. Preview match scores, industry and territory below.</p><p class="conversion-private">Your search stays private. Employers and recruiters cannot see your activity.</p></div>';
    main.prepend(header);
    const banner=document.getElementById('unlockBanner');
    if(banner){banner.className='masked-cta';banner.removeAttribute('style');banner.innerHTML='<div><h2>Ready to see the full details?</h2><p>Unlock job titles, employers, complete opportunity details and direct applications.</p><small>3 days free, then $19.99/month. Cancel anytime.</small></div><button type="button" id="unlockBannerBtn" class="btn btn-primary" onclick="rookGoToCheckout(\'banner\')">Start 3-Day Free Trial</button>';main.append(banner);}
    if(isV7() && banner) {
      banner.querySelector('h2').remove();
      banner.querySelector('p').remove();
      banner.querySelector('small').textContent='3 days free, then $19.99/month. Cancel anytime. Card required.';
      banner.querySelector('button').textContent='Unlock my matches — 3 days free';
      header.after(banner);
      const trust=document.createElement('nav');trust.className='conversion-trust';trust.setAttribute('aria-label','ROOK information');
      trust.innerHTML='<a href="rook-about.html" target="_blank" rel="noopener">About ROOK</a><a href="mailto:hello@rookcareers.com">Contact</a><a href="rook-privacy.html" target="_blank" rel="noopener">Privacy</a><a href="rook-terms.html" target="_blank" rel="noopener">Terms</a>';
      main.append(trust);
    }
    if(typeof rookApplyLimitedNavigation==='function') rookApplyLimitedNavigation();
  };
})();
