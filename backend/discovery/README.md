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

## Public market discovery input

`npm run discover-employers-market-shadow` searches a rotating, bounded set of
medical-device, diagnostics/lab, pharmaceutical, biotech, healthcare,
veterinary, and animal-health sales queries through the existing Adzuna API.
It filters to sales titles, rejects generic/confidential and recruiting-company
signals, deduplicates employers, and uses exact-label public Wikidata records
to add official corporate website evidence when available. Shadow mode is
read-only: it reports existing and unknown employers but does not create
candidates or employers.

`npm run discover-employers-market` sends the same bounded signals through this
validation pipeline and retries due candidates. Four of twelve query families
rotate each day, one result page per query, with at most twenty companies sent
to the pipeline per run. A signal for an already-monitored employer is retained
as investigation evidence instead of creating a duplicate. Missing official
website evidence and unsupported sources remain unresolved/retryable; only the
existing machine-validation gate can enroll an active employer.
