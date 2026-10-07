# ROOK Careers Product Contracts

See also: `.cursor/rules/rook-product-contracts.mdc` (always applied for Cursor agents).

## Definition

ROOK discovers **sales** roles in medical device, diagnostics/lab, pharmaceutical/biotech, veterinary, and animal health markets from official employer career sources.

## Critical invariants

| Contract | Implementation |
|---|---|
| Sales-only admission | `backend/relevanceFilter.js` |
| Server-side masking | `backend/pretrialProjection.js`, `backend/redaction.js` |
| Generalized titles + locations | `backend/maskedPresentation.js` |
| Scheduled 6-category discovery | `backend/runScheduledDiscovery.js` runs all six public queries each cycle (`--query-limit 6`) via `backend/discovery/publicJobSignals.js` |
| Skipped employers advance the queue | `backend/ingest.js` `markIngestSkip` always sets `last_checked_at` |
| Existing-employer discrepancy repair | Public signals for monitored employers trigger official-source re-ingest in `runPublicJobDiscovery.js` |
| Incomplete snapshot safety | Adapter `incompleteSnapshot` + `backend/ingest.js` |
| Inventory cleanup | `backend/scripts/auditAndCleanupNonSalesInventory.js` |

## Regression commands

```bash
npm run test-sales-admission
npm run test-masked-presentation
npm run test-pretrial-security
npm run test-current-funnel
npm run test-public-job-discovery
```

## Inventory cleanup

```bash
node backend/scripts/auditAndCleanupNonSalesInventory.js --report
node backend/scripts/auditAndCleanupNonSalesInventory.js --apply --max-invalid-pct 35
```
