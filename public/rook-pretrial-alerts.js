// Optional capture; session state is UX only and never grants job access.
(function () {
  const get = key => { try { return sessionStorage.getItem('rook_alert_'+key); } catch (_) { return null; } };
  const set = (key,value) => { try { sessionStorage.setItem('rook_alert_'+key,value); } catch (_) {} };
  const track = (name,source) => window.rookTrackFunnelEvent?.(name,{source});
  const captured = () => !!get('email');
  let exitAttached=false;
  let firstWaiting=false;
  function usefulCardsVisible() {
    if (document.visibilityState !== 'visible') return false;
    const list=document.getElementById('jobList');
    if (!list || list.dataset.demo !== 'false') return false;
    return [...list.querySelectorAll('.job-row')].some(row => {
      const box=row.getBoundingClientRect();
      return box.width>0 && box.height>0 && box.bottom>0 && box.top<innerHeight && getComputedStyle(row).visibility!=='hidden';
    });
  }
  function waitForViewing() {
    if(firstWaiting) return;
    firstWaiting=true;
    let visibleSince=null;
    const reset=()=>{visibleSince=null;};
    document.addEventListener('visibilitychange',reset);
    function frame(time) {
      if(captured() || get('trial_clicked') || rookV7Snapshot?.alert_requested || rookV7Unlocked) {firstWaiting=false;document.removeEventListener('visibilitychange',reset);return;}
      if(!usefulCardsVisible()) visibleSince=null;
      else if(visibleSince===null) visibleSince=time;
      if(visibleSince!==null && time-visibleSince>=3000) {
        firstWaiting=false;
        document.removeEventListener('visibilitychange',reset);
        window.rookPretrialAlerts.dashboard(true);
      } else requestAnimationFrame(frame);
    }
    // The first frame precedes paint. Start observing on the following frame.
    requestAnimationFrame(()=>requestAnimationFrame(frame));
  }
  let firstShown=!!get('first_shown') || !!get('skipped');
  async function signedIn() {
    try { return !!(await rookV7Auth().auth.getSession()).data?.session; } catch (_) { return true; }
  }
  function prompt(source, done) {
    const modal=document.createElement('dialog');
    modal.setAttribute('aria-labelledby','rook-alert-heading');
    modal.style.cssText='border:1px solid #dbe8f0;border-radius:18px;padding:28px;max-width:440px;width:calc(100% - 32px);margin:auto;color:#062d55;font-family:Inter,system-ui,sans-serif;box-sizing:border-box';
    modal.innerHTML=`<h2 id="rook-alert-heading" style="font-size:25px;margin:0 0 14px">${source==='exit' ? "Don't lose your matches" : 'Be the first to know about new jobs'}</h2><p style="line-height:1.6">${source==='exit' ? 'Get notified when new jobs matching your search are added to ROOK.' : 'Get notified when ROOK finds new medical and veterinary sales opportunities that match your profile.'}</p><form><label for="rook-alert-email">Email address</label><input id="rook-alert-email" type="email" autocomplete="email" maxlength="254" required style="display:block;width:100%;box-sizing:border-box;margin:8px 0 16px;padding:14px;border:1px solid #587283;border-radius:10px;font:inherit"><p style="font-size:12px;line-height:1.5">By selecting ${source==='exit'?'Send Me New Matches':'Email Me New Matches'}, you request ROOK job-match emails. Unsubscribe anytime. No account or trial required.</p><p role="status" style="color:#a22;min-height:18px"></p><button type="submit" style="width:100%;padding:15px;border:0;border-radius:30px;background:#0877d1;color:white;font:700 16px system-ui">${source==='exit'?'Send Me New Matches':'Email Me New Matches'}</button></form><button type="button" data-skip style="display:block;width:100%;padding:16px;background:none;border:0;text-decoration:underline;color:#062d55;font:600 15px system-ui">${source==='exit'?'No thanks':'Skip for now'}</button>`;
    document.body.append(modal);
    let finished=false;
    const close=skip=>{
      if(finished) return; finished=true;
      if(skip) {set('skipped','1');track(source==='exit'?'pretrial_exit_email_dismissed':'pretrial_email_skipped',source);}
      modal.close(); modal.remove(); done();
    };
    modal.querySelector('[data-skip]').onclick=()=>close(true);
    modal.addEventListener('cancel',e=>{e.preventDefault();close(true);});
    modal.querySelector('form').onsubmit=async e=>{
      e.preventDefault(); const button=modal.querySelector('[type=submit]'); button.disabled=true;
      const email=modal.querySelector('input').value.trim().toLowerCase();
      try {
        const response=await rookV7Request('/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,source,consent:true}),signal:AbortSignal.timeout(10000)});
        const data=await response.json();
        if(!response.ok) throw Error(data.error || 'Unable to save. Please retry or skip.');
        set('email',email); track(source==='exit'?'pretrial_exit_email_captured':'pretrial_email_captured',source);close(false);
      } catch(err) {if(!finished) modal.querySelector('[role=status]').textContent=err.name==='TimeoutError'?'Please retry, or skip to your matches.':err.message;}
      finally {button.disabled=false;}
    };
    modal.showModal();track(source==='exit'?'pretrial_exit_email_prompt_viewed':'pretrial_email_prompt_viewed',source);
  }
  window.rookPretrialAlerts={
    first() {
      location.href='rook-dashboard-v7.html';
    },
    async dashboard(viewed=false) {
      if(new URLSearchParams(location.search).get('from')==='job_alert') track('pretrial_job_email_returned','job_alert');
      if(captured() || get('trial_clicked') || rookV7Snapshot?.alert_requested || rookV7Unlocked || await signedIn()) return;
      if(!firstShown) {
        if(!viewed || !usefulCardsVisible()) {waitForViewing();return;}
        firstShown=true;set('first_shown','1');
        prompt('onboarding',()=>{window.rookPretrialAlerts.dashboard();});
        return;
      }
      if(exitAttached || !get('skipped') || captured() || get('exit_shown') || get('trial_clicked') || rookV7Snapshot?.alert_requested || rookV7Unlocked || await signedIn()) return;
      if(!matchMedia('(hover: hover) and (pointer: fine)').matches || navigator.maxTouchPoints>0) return;
      exitAttached=true;
      const started=Date.now();
      document.addEventListener('mouseout',async function exit(e) {
        if(e.relatedTarget || e.clientY>0 || Date.now()-started<10000 || get('exit_shown') || get('trial_clicked') || captured() || document.querySelector('dialog[open]')) return;
        if(await signedIn()) return;
        if(get('exit_shown')) return;
        set('exit_shown','1');document.removeEventListener('mouseout',exit);prompt('exit',()=>{});
      });
    },
    trial(){set('trial_clicked','1');},
    email:()=>get('email') || ''
  };
})();
