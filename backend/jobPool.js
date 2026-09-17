// Paginate before eligibility/industry filtering; database response caps must
// not silently discard a selected industry's jobs before the scoring cap.
async function readJobPool(query, {accept = () => true, maxAccepted = Infinity} = {}) {
  const rows = [];
  query = query.order('id', { ascending: true });
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    for (const row of data || []) {
      if (accept(row)) rows.push(row);
      if (rows.length >= maxAccepted) return {data:rows,error:null};
    }
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}
module.exports = { readJobPool };
