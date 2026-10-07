const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot() {
  const calls = [];
  const inputEl = {
    value: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {},
    contains() { return false; },
  };
  const listEl = {
    id: 'locationList',
    hidden: true,
    innerHTML: '',
    children: [],
    setAttribute() {},
    querySelectorAll() { return this.children; },
    appendChild(node) { this.children.push(node); },
    contains() { return false; },
  };
  const statusEl = { textContent: '', style: {} };
  let selected = null;
  const context = {
    console,
    document: { addEventListener() {} },
    fetch: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ([
          { label: 'Orlando, FL', city: 'Orlando', state: 'Florida', stateAbbr: 'FL', lat: 28.5, lng: -81.3, zip: '32801' },
          { label: 'Orlando, OK', city: 'Orlando', state: 'Oklahoma', stateAbbr: 'OK', lat: 36.1, lng: -97.3, zip: '73073' },
        ]),
      };
    },
    window: {},
  };
  context.window = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../public/rook-location-widget-v8.js'), 'utf8'),
    context,
  );
  const widget = context.RookLocationWidget.init({
    inputEl,
    listEl,
    statusEl,
    onSelect: (value) => { selected = value; },
    onClear: () => { selected = null; },
  });
  return { inputEl, widget, getSelected: () => selected, calls };
}

test('location widget resolves a typed city on submit without requiring a click', async () => {
  const { inputEl, widget, getSelected, calls } = boot();
  inputEl.value = 'Orlando, FL';
  const resolved = await widget.resolveFromInput();
  assert.equal(resolved.city, 'Orlando');
  assert.equal(resolved.stateAbbr, 'FL');
  assert.equal(getSelected().label, 'Orlando, FL');
  assert.equal(inputEl.value, 'Orlando, FL');
  assert.equal(calls.length, 1);
});
