/**
 * rook-location-widget.js
 * Reusable "primary job-search location" autocomplete input.
 * Used by: rook-onboarding-v2.html (step 3b) and rook-dashboard.html.
 *
 * Calls /api/location-search?q=<text> (no auth required) which proxies
 * OpenStreetMap Nominatim server-side. Nominatim's usage policy prohibits
 * direct browser calls, which is why this goes through the ROOK backend.
 *
 * Contract:
 *   window.RookLocationWidget.init(opts) -> { getValue, setValue, reset }
 *
 *   opts = {
 *     inputEl:      <input> element             (required)
 *     listEl:       <ul> element for suggestions (required)
 *     statusEl:     <div> for status messages   (optional)
 *     onSelect:     function(suggestion)         (required)
 *     onClear:      function()                   (optional)
 *     apiBase:      string, default ''           (optional)
 *   }
 *
 *   suggestion = { label, city, state, stateAbbr, lat, lng, zip }
 *
 * The widget:
 *   - Debounces 350ms after the last keystroke before fetching
 *   - Requires min 2 characters
 *   - Requires explicit selection (Enter on highlighted item or mouse click)
 *   - Does NOT silently commit the first suggestion on arbitrary keypresses
 *   - Closes the list on Escape or click outside
 *   - Is accessible: arrow-key navigation, aria-activedescendant, role=listbox
 */
(function () {
  "use strict";

  const DEBOUNCE_MS = 350;

  function init(opts) {
    const { inputEl, listEl, statusEl, onSelect, onClear, apiBase = "" } = opts;
    if (!inputEl || !listEl || !onSelect) {
      console.error("[RookLocationWidget] Missing required opts: inputEl, listEl, onSelect");
      return null;
    }

    let debounceTimer = null;
    let suggestions = [];
    let activeIdx = -1;
    let committed = false; // true after a valid suggestion is selected

    // a11y setup
    inputEl.setAttribute("autocomplete", "off");
    inputEl.setAttribute("aria-autocomplete", "list");
    inputEl.setAttribute("aria-haspopup", "listbox");
    inputEl.setAttribute("role", "combobox");
    listEl.setAttribute("role", "listbox");
    listEl.id = listEl.id || ("rlw-list-" + Math.random().toString(36).slice(2));
    inputEl.setAttribute("aria-controls", listEl.id);

    function setStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.style.color = isError ? "#C23B3B" : "#637589";
    }

    function clearList() {
      listEl.innerHTML = "";
      listEl.hidden = true;
      suggestions = [];
      activeIdx = -1;
      inputEl.removeAttribute("aria-activedescendant");
    }

    function renderList(items) {
      clearList();
      if (!items.length) return;
      suggestions = items;
      items.forEach((s, i) => {
        const li = document.createElement("li");
        li.id = `${listEl.id}-item-${i}`;
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", "false");
        li.className = "rlw-item";
        // Format: "34484 -- Oxford, FL" or "Boise, ID"
        li.textContent = s.label;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault(); // don't blur input
          commit(i);
        });
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    }

    function setActive(idx) {
      const items = listEl.querySelectorAll(".rlw-item");
      items.forEach((li, i) => {
        const active = i === idx;
        li.classList.toggle("rlw-active", active);
        li.setAttribute("aria-selected", String(active));
      });
      activeIdx = idx;
      if (idx >= 0 && items[idx]) {
        inputEl.setAttribute("aria-activedescendant", items[idx].id);
        items[idx].scrollIntoView({ block: "nearest" });
      } else {
        inputEl.removeAttribute("aria-activedescendant");
      }
    }

    function commit(idx) {
      const s = suggestions[idx];
      if (!s) return;
      committed = true;
      inputEl.value = s.label;
      clearList();
      setStatus("");
      onSelect(s);
    }

    async function fetchSuggestions(q) {
      setStatus("Searching...");
      try {
        const res = await fetch(`${apiBase}/api/location-search?q=${encodeURIComponent(q)}`);
        if (!res.ok) {
          setStatus("Could not search right now. Try again.");
          clearList();
          return;
        }
        const items = await res.json();
        if (!Array.isArray(items) || !items.length) {
          setStatus('No U.S. locations found for "' + q + '".');
          clearList();
          return;
        }
        setStatus("");
        renderList(items);
      } catch {
        setStatus("Search unavailable. Enter a ZIP code instead.");
        clearList();
      }
    }

    inputEl.addEventListener("input", () => {
      committed = false;
      if (onClear) onClear();
      const q = inputEl.value.trim();
      clearTimeout(debounceTimer);
      if (q.length < 2) { clearList(); setStatus(""); return; }
      debounceTimer = setTimeout(() => fetchSuggestions(q), DEBOUNCE_MS);
    });

    inputEl.addEventListener("keydown", (e) => {
      const len = suggestions.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(len ? (activeIdx + 1) % len : -1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(len ? (activeIdx - 1 + len) % len : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0) { commit(activeIdx); }
        // No action if nothing is highlighted -- user must select explicitly
      } else if (e.key === "Escape") {
        clearList();
        setStatus("");
      }
    });

    document.addEventListener("click", (e) => {
      if (!inputEl.contains(e.target) && !listEl.contains(e.target)) clearList();
    });

    // Public API
    function getValue() {
      return committed ? inputEl.value : null;
    }

    function setValue(suggestion) {
      if (!suggestion) return;
      committed = true;
      inputEl.value = suggestion.label || "";
      clearList();
      setStatus("");
    }

    function reset() {
      committed = false;
      inputEl.value = "";
      clearList();
      setStatus("");
      if (onClear) onClear();
    }

    return { getValue, setValue, reset };
  }

  window.RookLocationWidget = { init };
})();
