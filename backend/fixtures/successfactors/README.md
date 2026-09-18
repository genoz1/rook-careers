# SuccessFactors fixtures

These are synthetic, not downloaded pages — this environment has no outbound
network access to arbitrary external hosts, so unlike the custom_html
fixtures (real downloaded HTML) these model the row/pagination shapes
described by research-tool structural summaries of real CSB tenants
checked this session (Astellas, Getinge, Boston Scientific, Olympus,
Teleflex, Terumo, Dentsply Sirona, KARL STORZ, DiaSorin, Boehringer
Ingelheim). Treat the first real ingestion run against each tenant as the
actual confirmation, same convention noted in successfactors.js's own
header comment.

- single-page.html: one results page, table-based skin, location in its own
  cell (models the "14 results, single page" shape reported for Astellas).
- page1.html / page2.html: two-page paginated result set, div-based skin,
  no separate location cell — location only recoverable from the detail
  URL's own slug (models the Getinge/Boston Scientific pagination shape).
- empty.html: a results page with no /job/ links at all (models the
  Kedrion/Ambu "nothing returned" shape — cause not determined; the
  adapter must fail safely here, not report a false empty success).
- detail-*.html: minimal detail pages used by the description-fetch step.
