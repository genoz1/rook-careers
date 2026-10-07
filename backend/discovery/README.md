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

This job-market input is supplemental and is not the primary discovery
schedule.

## Company-first discovery

`npm run discover-companies-shadow` starts from employer ecosystems rather than
job-board results. Its primary live source is NAVC's public official VMX 2027
exhibitor directory, complemented by ROOK's curated medical-device,
diagnostics/lab, pharma/biotech, healthcare-technology, dental, and
animal-health company catalog. It compares the full company universe with
active ROOK employers before doing bounded enrichment work.

Official websites come first from the exhibitor's public VMX profile, then from
public Wikidata or a maximum of two deterministic domain checks that require
the page itself to corroborate the company identity. Shadow mode resolves
official careers pages, detects ATS configurations, and runs the same read-only
machine validation used by Phase 2. Apply mode sends only the bounded unknown
company batch through Phase 2; it never writes employers directly.

## Continuous public-job discovery

`npm run discover-public-jobs-shadow` reads a small rotating set of current
public LinkedIn guest-job results without cookies, login, or an authenticated
account, plus Jobicy's free public API. These are discovery signals only: ROOK
extracts and deduplicates employer names, resolves an official company site,
and then uses the official careers source through Phase 2. Access restrictions
fail closed; the code does not attempt to bypass an auth wall or CAPTCHA.

`npm run discover-employers-scheduled` is the bounded autonomous daily loop:
current public-job signals first, a small rotating VMX/catalog seed batch
second, and due Phase 2 retries last. A newly enrolled employer is immediately
ingested from its validated official source and remains in normal monitoring.
The existing Adzuna market command remains available only as a supplemental,
unscheduled input.
