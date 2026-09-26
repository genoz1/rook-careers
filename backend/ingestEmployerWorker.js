const { measure } = require('./ingestRunMetrics');
const { createClient } = require('@supabase/supabase-js');
const {
  withTitleFilterDiagnostics,
  getTitleFilterRejections,
  persistTitleFilterRejections,
} = require('./titleFilterDiagnostics');
process.once('message', async employer => {
  await withTitleFilterDiagnostics(employer, async () => {
    let result;
    try {
      const { ingestEmployer } = require('./ingest');
      result = { type: 'done', ...(await measure(() => ingestEmployer(employer))) };
    } catch (error) {
      result = { type: 'failed', error: error.message };
    }

    const rejections = getTitleFilterRejections();
    if (rejections.length) {
      try {
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const count = await persistTitleFilterRejections(db, rejections);
        console.log('INGEST_TITLE_FILTER_REJECTIONS_SAVED', JSON.stringify({ employer_id: employer.id, count }));
      } catch (error) {
        // Diagnostic persistence must never change a source sync's outcome.
        console.error('INGEST_TITLE_FILTER_DIAGNOSTICS_SAVE_FAILED', JSON.stringify({ employer_id: employer.id, count: rejections.length, error: error.message }));
      }
    }
    process.send(result, () => process.exit(result.type === 'done' ? 0 : 1));
  });
});
