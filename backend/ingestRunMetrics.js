const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
function metric(name, amount = 1) {
  const state = scope.getStore(); if (!state) return;
  state[name] = (state[name] || 0) + amount;
  if (process.send) process.send({ type: 'progress', metrics: state });
}
async function measure(action) {
  const state = { inserted: 0, updated: 0, closed: 0, source_failures: 0, write_failures: 0, embedding_failures: 0, partial_snapshots: 0 };
  return scope.run(state, async () => ({ result: await action(), metrics: state }));
}
module.exports = { metric, measure };
