// Paginate before eligibility/industry filtering; database response caps must
// not silently discard a selected industry's jobs before the scoring cap.
async function readJobPool(query) {
  const rows = [];
  query = query.order('id', { ascending: true });
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}
module.exports = { readJobPool };
