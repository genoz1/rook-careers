class SupabaseDiscoveryStore {
  constructor(client) { this.client = client; }

  async getCandidate(identityKey) {
    const { data, error } = await this.client.from('employer_discovery_candidates').select('*').eq('identity_key', identityKey).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async receiveCandidate(row) {
    let existing = await this.getCandidate(row.identity_key);
    if (!existing && row.company_domain) {
      const { data, error } = await this.client.from('employer_discovery_candidates').select('*')
        .eq('company_domain', row.company_domain).limit(1).maybeSingle();
      if (error) throw error;
      existing = data || null;
    }
    if (existing) {
      const { data, error } = await this.client.from('employer_discovery_candidates')
        .update({
          last_signal_at: row.last_signal_at,
          signal_payload: { ...(existing.signal_payload || {}), ...(row.signal_payload || {}) },
          company_website: row.company_website || existing.company_website,
          careers_url: row.careers_url || existing.careers_url,
          job_url: row.job_url || existing.job_url,
          industry: row.industry || existing.industry,
          updated_at: row.last_signal_at,
        })
        .eq('id', existing.id).select('*').single();
      if (error) throw error;
      return { candidate: data, duplicate: true };
    }
    const { data, error } = await this.client.from('employer_discovery_candidates').insert(row).select('*').single();
    if (error) {
      if (error.code === '23505') return { candidate: await this.getCandidate(row.identity_key), duplicate: true };
      throw error;
    }
    return { candidate: data, duplicate: false };
  }

  async updateCandidate(id, patch) {
    const { data, error } = await this.client.from('employer_discovery_candidates').update(patch).eq('id', id).select('*').single();
    if (error) throw error;
    return data;
  }

  async listEmployers() {
    const { data, error } = await this.client.from('employers')
      .select('id,company_name,company_slug,company_website,careers_url,ats_type,ats_identifier,active,discovery_candidate_id');
    if (error) throw error;
    return data || [];
  }

  async findCandidateBySource(atsType, atsIdentifier) {
    const { data, error } = await this.client.from('employer_discovery_candidates').select('*')
      .eq('detected_ats_type', atsType).eq('detected_ats_identifier', atsIdentifier)
      .in('status', ['existing', 'enrolled']).limit(1).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async listDueCandidates(limit = 50, now = new Date()) {
    const { data, error } = await this.client.from('employer_discovery_candidates').select('*')
      .in('status', ['received', 'retryable', 'unresolved'])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
      .order('next_attempt_at', { ascending: true, nullsFirst: true }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  async listCandidatesByIds(ids) {
    const unique = [...new Set((ids || []).map(String))];
    if (!unique.length) return [];
    const { data, error } = await this.client.from('employer_discovery_candidates').select('*').in('id', unique);
    if (error) throw error;
    const byId = new Map((data || []).map((candidate) => [candidate.id, candidate]));
    return unique.map((id) => byId.get(id)).filter(Boolean);
  }

  async enrollEmployer(candidate, configuration) {
    const companySlug = candidate.normalized_company_name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const row = {
      company_name: candidate.company_name,
      company_slug: companySlug,
      company_website: candidate.company_website,
      careers_url: configuration.source_url,
      source_url: configuration.source_url,
      ats_type: configuration.ats_type,
      ats_identifier: configuration.ats_identifier,
      industry: candidate.industry || null,
      active: true,
      priority: 'normal',
      sync_status: 'pending',
      discovery_candidate_id: candidate.id,
    };
    const { data, error } = await this.client.from('employers').upsert(row, { onConflict: 'company_slug' }).select('*').single();
    if (error) throw error;
    return data;
  }
}

module.exports = { SupabaseDiscoveryStore };
