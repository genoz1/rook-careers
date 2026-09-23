const { measure } = require('./ingestRunMetrics');
process.once('message', async employer => {
  try {
    const { ingestEmployer } = require('./ingest');
    const measured = await measure(() => ingestEmployer(employer));
    process.send({ type: 'done', ...measured }, () => process.exit(0));
  } catch (error) {
    process.send({ type: 'failed', error: error.message }, () => process.exit(1));
  }
});
