// PostgREST limits a response to 1,000 rows by default. Read all pages before
// counting distinct employers, or the public number depends on job ID order.
async function countPublicEmployers(supabaseAdmin, pageSize = 1000) {
  const ids = new Set();
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('id, employer_id')
      .eq('status', 'active')
      .eq('moderation_status', 'approved')
      .not('employer_id', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Missing jobs page');
    for (const row of data) ids.add(row.employer_id);
    if (data.length < pageSize) return ids.size;
  }
}

module.exports = { countPublicEmployers };
