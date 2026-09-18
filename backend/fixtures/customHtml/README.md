# Careers fixtures

Public HTML downloaded September 18, 2026. Scripts, styles, images, navigation,
footer and non-semantic attributes removed; job copy and section structure retained.
These fixtures are test inputs, not assertions that a position remains open.

- bionote.html: https://www.bionote.com/careers
- aurora.html: https://www.aurorapharmaceutical.com/careers
- petvivo.html: https://www.petvivo.com/open-positions
  Its linked https://www.petvivo.com/inside-sales-rep returned HTTP 404.
- torigen-legacy.html: https://conor-odonoghue-83km.squarespace.com/careers
  Unverified legacy host. https://www.torigen.com/careers returned HTTP 404.
  Do not enroll the legacy host as official without independent confirmation.
- tg-therapeutics*.html: https://www.tgtherapeutics.com/about-us/join-us/
  Reconstructed from a WebFetch structural read (Sept 18, 2026), not a byte
  download — this sandbox has no outbound access to tgtherapeutics.com.
  Trimmed to 4 of the page's real ~17 postings. Confirmed genuinely
  ATS-free: flat list of role-titled links to per-job pages, applications
  by email. Treat the first real ingestion run as the actual confirmation.
