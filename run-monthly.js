/**
 * Monthly automation pipeline for the two Bobnická sharing groups.
 * Runs on the 12th of each month (via GitHub Actions or locally).
 *
 * Steps:
 *   1. Login to EDC portal
 *   2. For each group (A, B): export IN/OUT data for the previous month
 *      → save to exports/Export-{group}-{YYYY}-{MM}-inout.csv
 *   3. Generate HTML report
 *   4. Logout
 *
 * No allocation (PAIR) export, no upload, no email.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { EdcApi } = require('./lib/edc-api');

const ROOT = __dirname;
const EXPORTS_DIR = path.join(ROOT, 'exports');

// Load .env if present
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const EDC_USERNAME = process.env.EDC_USERNAME;
const EDC_PASSWORD = process.env.EDC_PASSWORD;
const SSE_ID_A = process.env.SSE_ID_A;
const SSE_ID_B = process.env.SSE_ID_B;

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`[${ts}] ${msg}`);
}

function getPreviousMonth() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // 1-based
  return { year, month };
}

async function exportGroup(api, groupId, sseId, dateFrom, dateTo, monthStr, year) {
  const fileName = `Export-${groupId}-${year}-${monthStr}-inout`;
  log(`  ${groupId}: pozadavek na export (SSE ID ${sseId})...`);
  const { csv } = await api.exportAndDownload({
    sseId: Number(sseId),
    dateFrom,
    dateTo,
    inputData: true,
    outputData: true,
    profileType: 'STANDARD',
    fileName,
  });
  const outPath = path.join(EXPORTS_DIR, `${fileName}.csv`);
  fs.writeFileSync(outPath, csv, 'utf-8');
  log(`  ${groupId}: ulozeno ${outPath} (${(csv.length / 1024).toFixed(0)} KB)`);

  const nonEmpty = csv.split('\n').filter(l => l.trim()).length;
  if (nonEmpty < 5) {
    throw new Error(`Export skupiny ${groupId} pro ${year}-${monthStr} je prazdny (jen hlavicka). Mesicni data EDC zrejme jeste nejsou publikovana.`);
  }
}

async function main() {
  log('=== MESICNI REPORT SDILENI - BOBNICKA ===');

  if (!EDC_USERNAME || !EDC_PASSWORD) {
    console.error('CHYBA: Nastav EDC_USERNAME a EDC_PASSWORD v .env nebo env promennych');
    process.exit(1);
  }
  if (!SSE_ID_A || !SSE_ID_B) {
    console.error('CHYBA: Nastav SSE_ID_A a SSE_ID_B v .env (spust nejdriv: npm run discover)');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const { year, month } = getPreviousMonth();
  const monthStr = month.toString().padStart(2, '0');
  log(`Zpracovavam mesic: ${year}-${monthStr}`);

  const dateFrom = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const lastDay = new Date(year, month, 0).getDate();
  const dateTo = new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999));

  log('Krok 1: Prihlaseni k EDC portalu...');
  const api = new EdcApi(EDC_USERNAME, EDC_PASSWORD);
  await api.login();
  log('  Prihlaseni uspesne');

  try {
    log('Krok 2: Export IN/OUT dat pro obe skupiny sdileni...');
    await exportGroup(api, 'A', SSE_ID_A, dateFrom, dateTo, monthStr, year);
    await exportGroup(api, 'B', SSE_ID_B, dateFrom, dateTo, monthStr, year);

    log('Krok 3: Generovani HTML reportu...');
    execSync('node generate-report.js', { cwd: ROOT, stdio: 'inherit' });
    log('  report.html vygenerovan');

    log('');
    log('=== HOTOVO ===');
    log(`Mesic: ${year}-${monthStr}`);
    log(`Report: ${path.join(ROOT, 'report.html')}`);
  } finally {
    await api.logout().catch(() => {});
    log('Odhlaseno z EDC portalu.');
  }
}

main().catch(err => {
  console.error('FATALNI CHYBA:', err);
  process.exit(1);
});
