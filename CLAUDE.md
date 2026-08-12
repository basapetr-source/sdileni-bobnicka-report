# CLAUDE.md — Sdileni_Bobnicka

Monthly energy sharing report for two residential building entrances at "Rezidence nad Mrlinou" (Vchod A, Vchod B). Each entrance is its own SSE sharing group on the EDC portal.

Modeled on `../Sdileni_energie/` but **deliberately simpler**: only IN/OUT exports, no PAIR/allocation export, no upload back to EDC, no optimization, no e-mail. Output is just an HTML report published to GitHub Pages.

## Output

- `report.html` — interactive HTML report with two clearly separated sections (Vchod A, Vchod B)
- `docs/index.html` — copy of report.html, served by GitHub Pages

## Commands

```bash
npm run monthly    # Full pipeline: login → export both groups → generate report
npm run report     # Just regenerate HTML from CSVs already in exports/
npm run discover   # List SSE groups available to the EDC account (one-time setup)
```

## Architecture

```
Názvy elektroměrů dle EAN.xlsx    # Two sheets: "Vchod A", "Vchod B" — EAN→name (Společná, Byt 1..26)
exports/Export-{A|B}-{YYYY}-{MM}-inout.csv   # Downloaded each month from EDC
        ↓
lib/edc-api.js                    # EDC Keycloak OIDC + export endpoints; sseId is per-call
lib/parse-data.js                 # XLSX mapping + IN/OUT CSV parsing (group inferred from filename)
        ↓
generate-report.js                # → report.html with two group sections
run-monthly.js                    # Login → export A → export B → generate report → logout
```

The CSV filename convention `Export-{A|B}-{YYYY}-{MM}-inout.csv` is how `parse-data.js` tags each row with its sharing group. Don't change this convention without updating the regex in `parseAllCsvFiles`.

## EDC API

- Different account from `Sdileni_energie`: `basapetr@gmail.com` (in `.env`, also in GitHub Secrets).
- Two SSE groups discovered via `npm run discover`:
  - **37847** = Rezidence nad Mrlinou vchod A
  - **37848** = Rezidence nad Mrlinou vchod B
- `lib/edc-api.js` no longer hardcodes SSE_ID — caller passes it per export.
- IN/OUT export uses `calculationType: MONTHLY`, `profileType: STANDARD`. EDC still returns 15-min interval data; report aggregates monthly.
- **Export endpoint changed 08/2026** (404'd the 2026-08-12 run, same break as in `Sdileni_energie`): the unified `POST /profiles-data/export-profiles-data` is gone, replaced by `POST /profiles-data/{standard|pair}/export`. Body changed too — `sseId` is a plain number (not an array), dates are `yyyy-MM-dd` (not ISO timestamps), and `inputType` / `currentEnteredDateTime` / `profileType` were dropped. The export response now returns the planned report `{id, name, reportState}`, so `exportAndDownload` polls that ID (`pollReportById`) instead of diffing the report list.

## GitHub repo & automation

- Repo: **basapetr-source/sdileni-bobnicka-report** (public)
- Online: **https://basapetr-source.github.io/sdileni-bobnicka-report/** (Pages from `/docs` on `main`)
- Workflow `.github/workflows/monthly-update.yml`: cron on the 12th and 13th, 06:00 UTC. The 13th is a retry — a guard step skips the run when both `exports/Export-{A,B}-{prev month}-inout.csv` already exist and are non-empty. The guard applies **only to scheduled runs**, so `workflow_dispatch` always executes (useful for re-running after a fix).
- Secrets: `EDC_USERNAME`, `EDC_PASSWORD`, `SSE_ID_A`, `SSE_ID_B`.
- Pipeline commits `exports/*.csv`, `report.html`, `docs/index.html` back to repo.

## Report terminology (user preference)

In the producers/výroba table the user explicitly renamed:
- "Výroba (kWh)" → **"Přetoky (kWh)"**
- "Přebytek (kWh)" → **"Prodáno (kWh)"**
- summary card "Celková výroba" → **"Celkové přetoky"**

Match this terminology when editing the report — "výroba" implies the FVE produced, but the EDC IN value is actually the net overflow into the shared grid, not gross production.
