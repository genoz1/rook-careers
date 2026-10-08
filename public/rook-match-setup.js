/**
 * One-time job-match preference setup for authenticated members.
 *
 * Collects location (and territory) then industry before the optional résumé
 * prompt and before the dashboard loads matches. Uses existing PUT /profile
 * fields — does not invent a second preference store.
 */
(function (root) {
  'use strict';

  const INDUSTRIES = [
    { value: 'Diagnostics', label: 'Diagnostics / Laboratory' },
    { value: 'Medical Device', label: 'Medical Device' },
    { value: 'Pharmaceutical', label: 'Pharmaceutical' },
    { value: 'Biotech/Life Sciences', label: 'Biotechnology / Life Sciences' },
    { value: 'Healthcare SaaS', label: 'Healthcare / Health Tech' },
    { value: 'Dental', label: 'Dental' },
    { value: 'Veterinary', label: 'Veterinary / Animal Health' },
    { value: 'Distribution', label: 'Distribution' },
    { value: 'Capital Equipment', label: 'Capital Equipment' },
  ];

  const TERRITORIES = [
    { value: 'local', label: 'Local territory — home most nights' },
    { value: 'regional', label: 'Regional territory — some overnight travel' },
    { value: 'national', label: 'Large or national territory — frequent travel' },
    { value: 'remote', label: 'Remote or inside sales' },
  ];

  function classify() {
    return root.RookJobClassification || null;
  }

  function normalizeIndustries(selection) {
    const api = classify();
    if (api?.normalizeSelection) return api.normalizeSelection(selection);
    return Array.isArray(selection) ? selection.filter((v) => typeof v === 'string' && v.trim()) : [];
  }

  function hasCoords(profile) {
    return Number.isFinite(Number(profile?.home_lat)) && Number.isFinite(Number(profile?.home_lng));
  }

  function hasZip(profile) {
    return /^\d{5}$/.test(String(profile?.home_zip || '').trim());
  }

  function isNationwideDefault(profile) {
    const label = String(profile?.home_location_label || '').trim();
    return /^across the u\.?s\.?$/i.test(label) && !hasZip(profile);
  }

  function isBootstrapTerritory(profile) {
    const terr = Array.isArray(profile?.territory_size_preferences)
      ? profile.territory_size_preferences.map(String)
      : [];
    if (terr.length !== 2) return false;
    return terr.includes('remote') && terr.includes('national');
  }

  function missingLocation(profile) {
    if (!profile) return true;
    if (isNationwideDefault(profile)) return true;
    return !(hasCoords(profile) && hasZip(profile));
  }

  function missingIndustry(profile) {
    return normalizeIndustries(profile?.desired_industries).length === 0;
  }

  function missingTerritory(profile) {
    const terr = Array.isArray(profile?.territory_size_preferences)
      ? profile.territory_size_preferences.filter(Boolean)
      : [];
    if (!terr.length) return true;
    // Bootstrap defaults remote+national while industry was never chosen —
    // treat as unconfirmed so the member sets their search area.
    if (isBootstrapTerritory(profile) && missingIndustry(profile)) return true;
    return false;
  }

  function needsSetup(profile) {
    if (!profile) return true;
    return missingLocation(profile) || missingIndustry(profile) || missingTerritory(profile);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function ensureOverlay() {
    let overlay = document.getElementById('matchSetupOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'matchSetupOverlay';
    overlay.className = 'match-setup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'matchSetupTitle');
    overlay.innerHTML = `
      <div class="match-setup-card">
        <img class="match-setup-brand" src="assets/rook-full-logo-900.png" alt="ROOK">
        <p class="match-setup-step" id="matchSetupStepLabel">Step 1 of 2</p>
        <h2 id="matchSetupTitle">Set up your job matches</h2>
        <p class="match-setup-lead" id="matchSetupLead">Tell us where you want to search so we can show the right opportunities.</p>
        <div id="matchSetupBody"></div>
        <p class="match-setup-error" id="matchSetupError" hidden></p>
        <div class="match-setup-actions">
          <button type="button" class="match-setup-secondary" id="matchSetupBack" hidden>Back</button>
          <button type="button" class="match-setup-primary" id="matchSetupContinue">Continue</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function setError(msg) {
    const el = document.getElementById('matchSetupError');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function renderLocationStep(state) {
    const body = document.getElementById('matchSetupBody');
    const prefill = state.location?.label
      || [state.location?.city, state.location?.state].filter(Boolean).join(', ')
      || state.profile?.home_location_label
      || '';
    const nationwide = !!state.nationwide;
    body.innerHTML = `
      <label class="match-setup-label" for="matchSetupLocInput">City or ZIP code</label>
      <div class="match-setup-loc-wrap">
        <input id="matchSetupLocInput" type="text" autocomplete="off" placeholder="e.g. 30301 or Atlanta, GA"
          value="${esc(nationwide ? '' : prefill)}" ${nationwide ? 'disabled' : ''}>
        <ul id="matchSetupLocList" class="match-setup-loc-list" hidden></ul>
      </div>
      <div id="matchSetupLocStatus" class="match-setup-status" aria-live="polite"></div>
      <label class="match-setup-check">
        <input type="checkbox" id="matchSetupNationwide" ${nationwide ? 'checked' : ''}>
        Search across the entire U.S.
      </label>
      <fieldset class="match-setup-fieldset">
        <legend>Territory preferences</legend>
        <p class="match-setup-hint">Select all that apply.</p>
        <div class="match-setup-checks" id="matchSetupTerritories">
          ${TERRITORIES.map((t) => {
            const checked = (state.territories || []).includes(t.value) ? 'checked' : '';
            return `<label class="match-setup-check"><input type="checkbox" value="${esc(t.value)}" ${checked}> ${esc(t.label)}</label>`;
          }).join('')}
        </div>
      </fieldset>`;

    document.getElementById('matchSetupStepLabel').textContent = state.onlyIndustry
      ? 'Almost done'
      : (state.skipLocation ? 'Step 1 of 1' : 'Step 1 of 2');
    document.getElementById('matchSetupTitle').textContent = 'Where do you want to search?';
    document.getElementById('matchSetupLead').textContent =
      'Choose a city or ZIP, or explicitly search nationwide. We never use browser GPS.';

    const input = document.getElementById('matchSetupLocInput');
    const list = document.getElementById('matchSetupLocList');
    const status = document.getElementById('matchSetupLocStatus');
    const nationBox = document.getElementById('matchSetupNationwide');

    if (root.RookLocationWidget?.init) {
      state.widget = root.RookLocationWidget.init({
        inputEl: input,
        listEl: list,
        statusEl: status,
        onSelect: (place) => {
          state.location = place;
          state.nationwide = false;
          nationBox.checked = false;
          setError('');
        },
        onClear: () => {
          state.location = null;
        },
      });
      if (state.location?.label && state.widget.setValue) {
        try { state.widget.setValue(state.location); } catch (_) { /* older widget */ }
      }
    }

    nationBox.addEventListener('change', () => {
      state.nationwide = nationBox.checked;
      if (state.nationwide) {
        state.location = null;
        input.value = '';
        input.disabled = true;
        if (status) status.textContent = 'Nationwide search selected.';
      } else {
        input.disabled = false;
        if (status) status.textContent = '';
      }
      setError('');
    });
  }

  function renderIndustryStep(state) {
    const body = document.getElementById('matchSetupBody');
    const selected = new Set(state.industries || []);
    const allSelected = !!state.allIndustries;
    body.innerHTML = `
      <fieldset class="match-setup-fieldset">
        <legend>Which sales industries interest you?</legend>
        <p class="match-setup-hint">Select one or more, or choose All industries.</p>
        <label class="match-setup-check match-setup-all">
          <input type="checkbox" id="matchSetupAllIndustries" ${allSelected ? 'checked' : ''}>
          All industries
        </label>
        <div class="match-setup-checks" id="matchSetupIndustries">
          ${INDUSTRIES.map((ind) => {
            const checked = !allSelected && selected.has(ind.value) ? 'checked' : '';
            return `<label class="match-setup-check"><input type="checkbox" value="${esc(ind.value)}" ${checked} ${allSelected ? 'disabled' : ''}> ${esc(ind.label)}</label>`;
          }).join('')}
        </div>
      </fieldset>`;

    document.getElementById('matchSetupStepLabel').textContent = state.skipLocation ? 'Step 1 of 1' : 'Step 2 of 2';
    document.getElementById('matchSetupTitle').textContent = 'Which industries interest you?';
    document.getElementById('matchSetupLead').textContent =
      'We use this to rank medical and veterinary sales roles. You can change it anytime.';

    const allBox = document.getElementById('matchSetupAllIndustries');
    const boxes = () => Array.from(document.querySelectorAll('#matchSetupIndustries input[type="checkbox"]'));
    allBox.addEventListener('change', () => {
      state.allIndustries = allBox.checked;
      boxes().forEach((box) => {
        box.disabled = state.allIndustries;
        if (state.allIndustries) box.checked = false;
      });
      setError('');
    });
    boxes().forEach((box) => {
      box.addEventListener('change', () => setError(''));
    });
  }

  function readTerritories() {
    return Array.from(document.querySelectorAll('#matchSetupTerritories input:checked'), (el) => el.value);
  }

  function readIndustries(state) {
    if (document.getElementById('matchSetupAllIndustries')?.checked || state.allIndustries) {
      return { all: true, values: INDUSTRIES.map((i) => i.value) };
    }
    const values = Array.from(
      document.querySelectorAll('#matchSetupIndustries input:checked'),
      (el) => el.value
    );
    return { all: false, values: normalizeIndustries(values) };
  }

  function seedState(profile) {
    const industries = normalizeIndustries(profile?.desired_industries);
    let territories = Array.isArray(profile?.territory_size_preferences)
      ? profile.territory_size_preferences.filter(Boolean)
      : [];
    if (isBootstrapTerritory(profile) && missingIndustry(profile)) territories = [];

    const needLoc = missingLocation(profile) || missingTerritory(profile);
    const needInd = missingIndustry(profile);

    let location = null;
    if (hasCoords(profile) && hasZip(profile) && !isNationwideDefault(profile)) {
      location = {
        label: profile.home_location_label || [profile.home_city, profile.home_state].filter(Boolean).join(', '),
        city: profile.home_city || '',
        state: profile.home_state || '',
        stateAbbr: profile.home_state || '',
        lat: Number(profile.home_lat),
        lng: Number(profile.home_lng),
        zip: String(profile.home_zip),
      };
    }

    return {
      profile,
      step: needLoc ? 'location' : 'industry',
      skipLocation: !needLoc,
      onlyIndustry: !needLoc && needInd,
      location,
      nationwide: false,
      territories,
      industries,
      allIndustries: false,
      widget: null,
    };
  }

  function buildLocationPayload(state) {
    const territories = readTerritories();
    if (!territories.length) {
      throw new Error('Select at least one territory preference.');
    }
    if (state.nationwide) {
      return {
        home_lat: null,
        home_lng: null,
        home_city: null,
        home_state: null,
        home_zip: null,
        home_location_label: 'Across the U.S.',
        territory_size_preferences: territories,
        territory_size_preference: territories[0],
        work_style: territories.includes('remote') && territories.length === 1 ? 'remote' : 'field',
      };
    }
    const place = state.location;
    if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lng))) {
      throw new Error('Choose a city or ZIP from the suggestions, or select nationwide search.');
    }
    const stateAbbr = String(place.stateAbbr || place.state || '').trim().toUpperCase();
    const zip = String(place.zip || '').trim();
    if (!/^[A-Z]{2}$/.test(stateAbbr) || !/^\d{5}$/.test(zip)) {
      throw new Error('Choose a city or ZIP from the suggestions so we can save a complete location.');
    }
    return {
      home_lat: Number(place.lat),
      home_lng: Number(place.lng),
      home_city: String(place.city || '').slice(0, 150),
      home_state: stateAbbr,
      home_zip: zip,
      home_location_label: String(place.label || `${place.city}, ${stateAbbr}`).slice(0, 150),
      territory_size_preferences: territories,
      territory_size_preference: territories[0],
      work_style: territories.includes('remote') && territories.length === 1 ? 'remote' : 'field',
    };
  }

  function buildIndustryPayload(state) {
    const choice = readIndustries(state);
    if (!choice.all && !choice.values.length) {
      throw new Error('Select at least one industry, or choose All industries.');
    }
    // Persist explicit all-industries as the full taxonomy so the dashboard
    // does not treat an empty array as "never answered."
    return { desired_industries: choice.values };
  }

  async function run(options = {}) {
    const profile = options.profile || null;
    if (!needsSetup(profile)) return profile;

    const saveProfile = options.saveProfile;
    if (typeof saveProfile !== 'function') {
      throw new Error('RookMatchSetup.run requires saveProfile()');
    }

    const overlay = ensureOverlay();
    const state = seedState(profile);
    // If only territory+industry missing but location OK, still may start at location for territory.
    if (state.step === 'location' && !missingLocation(profile) && missingTerritory(profile)) {
      state.step = 'location'; // location step also collects territory
    }
    if (!missingLocation(profile) && !missingTerritory(profile) && missingIndustry(profile)) {
      state.step = 'industry';
      state.skipLocation = true;
    }

    overlay.classList.add('active');
    document.body.classList.add('match-setup-open');

    const backBtn = document.getElementById('matchSetupBack');
    const continueBtn = document.getElementById('matchSetupContinue');

    function showStep() {
      setError('');
      if (state.step === 'location') {
        renderLocationStep(state);
        backBtn.hidden = true;
        // Location-only repair (industry already on file) finishes here.
        continueBtn.textContent = missingIndustry(profile) ? 'Continue' : 'Save & see jobs';
      } else {
        renderIndustryStep(state);
        backBtn.hidden = state.skipLocation;
        continueBtn.textContent = 'Save & see jobs';
      }
      continueBtn.disabled = false;
      continueBtn.focus();
    }

    showStep();

    return new Promise((resolve, reject) => {
      backBtn.onclick = () => {
        if (state.step === 'industry' && !state.skipLocation) {
          state.step = 'location';
          showStep();
        }
      };

      continueBtn.onclick = async () => {
        setError('');
        continueBtn.disabled = true;
        const prevLabel = continueBtn.textContent;
        continueBtn.textContent = 'Saving…';
        try {
          if (state.step === 'location') {
            if (state.widget?.resolveFromInput && !state.nationwide && !state.location) {
              try {
                const resolved = await state.widget.resolveFromInput();
                if (resolved) state.location = resolved;
              } catch (_) { /* fall through to validation */ }
            }
            const locationPayload = buildLocationPayload(state);
            state.pendingLocationPayload = locationPayload;
            state.territories = locationPayload.territory_size_preferences;

            if (!missingIndustry(profile) && normalizeIndustries(profile.desired_industries).length) {
              const saved = await saveProfile(locationPayload);
              cleanup();
              resolve(saved || { ...profile, ...locationPayload });
              return;
            }
            state.step = 'industry';
            continueBtn.disabled = false;
            continueBtn.textContent = 'Save & see jobs';
            showStep();
            return;
          }

          const industryPayload = buildIndustryPayload(state);
          const payload = { ...(state.pendingLocationPayload || {}), ...industryPayload };
          // Preserve an already-valid location when this run was industry-only.
          if (!state.pendingLocationPayload && !missingLocation(profile) && !missingTerritory(profile)) {
            // industry-only update
          }
          const saved = await saveProfile(payload);
          cleanup();
          resolve(saved || { ...profile, ...payload });
        } catch (err) {
          setError(err.message || 'Could not save your preferences. Please try again.');
          continueBtn.disabled = false;
          continueBtn.textContent = prevLabel;
        }
      };

      function cleanup() {
        overlay.classList.remove('active');
        document.body.classList.remove('match-setup-open');
        backBtn.onclick = null;
        continueBtn.onclick = null;
      }

      // Expose cancel for tests only — production flow is required.
      overlay._rookMatchSetupReject = (err) => {
        cleanup();
        reject(err);
      };
    });
  }

  root.RookMatchSetup = {
    needsSetup,
    missingLocation,
    missingIndustry,
    missingTerritory,
    normalizeIndustries,
    INDUSTRIES,
    TERRITORIES,
    run,
    _test: {
      isNationwideDefault,
      isBootstrapTerritory,
      buildLocationPayload,
      buildIndustryPayload,
      seedState,
    },
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = root.RookMatchSetup;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
