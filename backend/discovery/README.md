# Automatic employer discovery

The Phase 2 engine consumes provider-neutral JSON signals. It does not scrape
LinkedIn or assume any single discovery provider.

```json
{
  "company_name": "Example Medical",
  "company_website": "https://example.com",
  "careers_url": "https://example.com/careers",
  "job_url": "https://job-boards.greenhouse.io/example/jobs/123",
  "job_title": "Territory Sales Manager",
  "industry": "medical device",
  "signal_source": "public-search-provider"
}
```

Feed a JSON array or JSONL file with:

```sh
npm run discover-employers-signals -- --input signals.jsonl
```

The scheduled `npm run discover-employers` command retries due durable
candidates. A candidate becomes an active employer only after the official
company site links or resolves to the source, the exact ATS identifiers are
extracted, the existing adapter retrieves jobs, and at least one active,
source-verified sales listing normalizes successfully. Unsupported sources and
failed validations remain in `employer_discovery_candidates` with evidence and
a retry time; they never create an active employer.
