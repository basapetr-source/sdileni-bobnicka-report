const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const EXPORTS_DIR = path.join(ROOT, 'exports');
const XLSX_FILE = path.join(ROOT, 'Názvy elektroměrů dle EAN.xlsx');

// Groups: each sharing group = one building entrance (Vchod)
const GROUPS = [
  { id: 'A', label: 'Vchod A', sheet: 'Vchod A', producerName: 'FVE Bobnická A' },
  { id: 'B', label: 'Vchod B', sheet: 'Vchod B', producerName: 'FVE Bobnická B' },
];

// ──── Read EAN → name mapping from XLSX ────
function readEanMapping() {
  const wb = XLSX.readFile(XLSX_FILE);

  // eanLabels[ean] = { name, group } for consumers
  // groupConsumers[groupId] = [ean, ean, ...] in display order
  const eanLabels = {};
  const groupConsumers = {};

  for (const g of GROUPS) {
    const ws = wb.Sheets[g.sheet];
    if (!ws) throw new Error(`Sheet "${g.sheet}" not found in ${XLSX_FILE}`);
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    groupConsumers[g.id] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[1]) continue;
      const name = String(row[0] || '').trim();
      const ean = String(row[1]).trim();
      if (!ean) continue;
      eanLabels[ean] = { name, group: g.id };
      groupConsumers[g.id].push(ean);
    }
  }

  return { eanLabels, groupConsumers, groups: GROUPS };
}

// ──── CSV helpers ────
function parseCzechNumber(str) {
  if (!str || str.trim() === '') return 0;
  return parseFloat(str.replace(',', '.'));
}

function getMonthKey(dateStr) {
  const parts = dateStr.split('.');
  return `${parts[2]}-${parts[1]}`;
}

function getMonthLabel(monthKey) {
  const [year, month] = monthKey.split('-');
  const months = ['', 'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
    'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];
  return `${months[parseInt(month)]} ${year}`;
}

// ──── Parse all IN/OUT CSVs in exports/ ────
// File name convention: Export-{groupId}-{YYYY}-{MM}-inout.csv
//   groupId comes from filename so we know which sharing group the rows belong to.
function parseAllCsvFiles() {
  if (!fs.existsSync(EXPORTS_DIR)) return [];
  const files = fs.readdirSync(EXPORTS_DIR).filter(f => f.endsWith('.csv'));
  const rows = []; // { groupId, date, ean, type:'D'|'O', inVal, outVal }

  for (const file of files) {
    const m = file.match(/Export-([AB])-(\d{4})-(\d{2})-inout\.csv$/i);
    if (!m) continue;
    const groupId = m[1].toUpperCase();

    const filePath = path.join(EXPORTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;

    const header = lines[0];
    const cols = header.split(';');
    if (!header.includes('IN-')) continue; // not an IN/OUT file

    const eanColumns = [];
    for (let c = 3; c < cols.length - 1; c += 2) {
      const inMatch = cols[c].match(/^IN-(\d+)-([DO])$/);
      if (inMatch) {
        eanColumns.push({ ean: inMatch[1], type: inMatch[2], inIdx: c, outIdx: c + 1 });
      }
    }

    for (let r = 1; r < lines.length; r++) {
      const vals = lines[r].split(';');
      if (vals.length < 4) continue;
      const date = vals[0];
      for (const col of eanColumns) {
        const inVal = parseCzechNumber(vals[col.inIdx]);
        const outVal = parseCzechNumber(vals[col.outIdx]);
        rows.push({ groupId, date, ean: col.ean, type: col.type, inVal, outVal });
      }
    }
  }

  // Deduplicate (groupId|date|hour|ean) - keep last
  const dedup = new Map();
  for (const row of rows) {
    const key = `${row.groupId}|${row.date}|${row.ean}|${row.type}`;
    // Same key across multiple rows of same day = multiple intervals; we want all intervals.
    // Use a counter for uniqueness instead. Just push.
    dedup.set(`${key}|${dedup.size}`, row);
  }
  return Array.from(dedup.values());
}

// ──── Aggregate per group → per EAN → per month ────
function aggregate(rows) {
  // result[groupId][ean] = { name, type, monthly: { 'YYYY-MM': { inSum, outSum } } }
  const result = { A: {}, B: {} };

  for (const row of rows) {
    const g = row.groupId;
    if (!result[g][row.ean]) {
      result[g][row.ean] = { type: row.type, monthly: {} };
    }
    const month = getMonthKey(row.date);
    if (!result[g][row.ean].monthly[month]) {
      result[g][row.ean].monthly[month] = { inSum: 0, outSum: 0 };
    }
    result[g][row.ean].monthly[month].inSum += row.inVal;
    result[g][row.ean].monthly[month].outSum += row.outVal;
  }

  return result;
}

module.exports = {
  ROOT,
  EXPORTS_DIR,
  XLSX_FILE,
  GROUPS,
  readEanMapping,
  parseCzechNumber,
  getMonthKey,
  getMonthLabel,
  parseAllCsvFiles,
  aggregate,
};
