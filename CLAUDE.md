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
- All HTTP calls go through `fetchWithRetry` in `lib/edc-api.js` (4 attempts, 2/5/15 s backoff, retries network errors + 429/502/503/504). Added after the 2026-09-12 run died on a `ConnectTimeoutError` to `sso.portal.edc-cr.cz` from the GitHub runner — but that turned out **not** to be the cause, see below. It still covers genuinely transient failures; do not treat it as the fix for the IP block.
- **Export endpoint changed 08/2026** (404'd the 2026-08-12 run, same break as in `Sdileni_energie`): the unified `POST /profiles-data/export-profiles-data` is gone, replaced by `POST /profiles-data/{standard|pair}/export`. Body changed too — `sseId` is a plain number (not an array), dates are `yyyy-MM-dd` (not ISO timestamps), and `inputType` / `currentEnteredDateTime` / `profileType` were dropped. The export response now returns the planned report `{id, name, reportState}`, so `exportAndDownload` polls that ID (`pollReportById`) instead of diffing the report list.

## GitHub repo & automation

- Repo: **basapetr-source/sdileni-bobnicka-report** (public)
- Online: **https://basapetr-source.github.io/sdileni-bobnicka-report/** (Pages from `/docs` on `main`)
- **The monthly job runs locally, not in GitHub Actions** (since 2026-09-12). EDC silently drops TCP :443 from GitHub's hosted runner IP ranges on all three `*.edc-cr.cz` hosts — DNS resolves, the handshake never completes. Verified from a runner that day: 20/20 connect attempts timed out over 10 minutes, so retrying cannot help. The job needs a Czech IP.
  - Windows scheduled task `SdileniBobnickaMonthly` runs `run-monthly-local.ps1` on the 12th and 13th at 8:00 (the 13th is the retry; the script's own guard skips it when both `exports/Export-{A,B}-{prev month}-inout.csv` exist and are non-empty). It pulls, runs the pipeline, copies `report.html` to `docs/index.html`, commits and pushes. Output goes to `run-monthly-local.log`.
  - The task stores the account password so it runs without login. Registered by `register-task.ps1`. Without the password (S4U mode) it would still run, but Windows Credential Manager could not decrypt the GitHub credentials and `git push` would fail.
  - Both scripts and the log are gitignored — this repo is public and they carry local paths.
- **Deliberately no self-hosted runner here.** `Sdileni_energie` uses one, but that repo is private. This one is public, and a self-hosted runner on a public repo lets a fork's pull request execute code on the machine. **Never add a `pull_request` trigger to a workflow in this repo.**
- The workflow is kept on `workflow_dispatch` only, as a probe: dispatch it to check whether EDC has lifted the block. If it passes, the cron lines can come back and the local task can go.
- Secrets (only needed if the workflow is ever restored to cron): `EDC_USERNAME`, `EDC_PASSWORD`, `SSE_ID_A`, `SSE_ID_B`. The local task reads the same values from `.env`.
- Pipeline commits `exports/*.csv`, `report.html`, `docs/index.html` back to repo.
- Commit message `Měsíční report YYYY-MM` uses the **run** month, not the data month — a commit labelled 2026-09 carries srpen (August) data. Follow that convention when committing a catch-up run by hand.
- Publish straight to `main` (no feature branch): Pages serves `/docs` from `main`, and the workflow itself pushes there, so a PR branch would not go live.

## Report terminology (user preference)

In the producers/výroba table the user explicitly renamed:
- "Výroba (kWh)" → **"Přetoky (kWh)"**
- "Přebytek (kWh)" → **"Prodáno (kWh)"**
- summary card "Celková výroba" → **"Celkové přetoky"**

Match this terminology when editing the report — "výroba" implies the FVE produced, but the EDC IN value is actually the net overflow into the shared grid, not gross production.
