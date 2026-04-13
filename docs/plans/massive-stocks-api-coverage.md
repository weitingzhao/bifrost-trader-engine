# Massive (Polygon) Stocks API coverage

Comparison of official Massive / Polygon **Stocks** REST, WebSocket, and flat-file surfaces against this repository: `MassiveClient`, Celery `massive` jobs, Feed → Massive Stock checklist capabilities, and pytest coverage.

## Open the sheet

- **[Interactive HTML viewer](massive_stocks_api_coverage.html)** — filterable table (same asset used in the monitoring UI iframe).
- **[CSV export](massive_stocks_api_coverage.csv)** — import into Excel or Google Sheets.

## MkDocs URLs

With the docs site running (`mkdocs serve` or `python scripts/run_mkdocs.py`, default [http://127.0.0.1:8000](http://127.0.0.1:8000)):

| Asset | Path |
|-------|------|
| This overview page | `/plans/massive-stocks-api-coverage/` |
| Full-page viewer | `/plans/massive_stocks_api_coverage.html` |
| Spreadsheet source | `/plans/massive_stocks_api_coverage.csv` |

MkDocs copies everything under `docs/` into the built site; `.html` and `.csv` in `docs/plans/` are served as static files next to generated Markdown pages.

## Monitoring UI

**Settings → Feed → Massive Stock** includes **Open in new tab** and **Show embedded viewer** for the same HTML served from `frontend/public/plans/massive_stocks_api_coverage.html`.

After editing `docs/plans/massive_stocks_api_coverage.html`, sync to the frontend before `vite build`:

```bash
cd frontend && npm run sync:massive-coverage
```

Canonical sources live under `docs/plans/`; the copy under `frontend/public/plans/` is for same-origin delivery with the React app.
