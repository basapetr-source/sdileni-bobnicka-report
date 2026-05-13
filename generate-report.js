const fs = require('fs');
const path = require('path');
const {
  ROOT, GROUPS, readEanMapping, parseAllCsvFiles, aggregate, getMonthLabel,
} = require('./lib/parse-data');

const OUTPUT_HTML = path.join(ROOT, 'report.html');

// ──────────────────── BUILD HTML ────────────────────
function buildGroupBlock(group, groupData, eanLabels, months, producerName) {
  // Split into producers (type D) and consumers (type O)
  const producers = [];
  const consumers = [];
  for (const ean of Object.keys(groupData)) {
    const item = groupData[ean];
    const labelInfo = eanLabels[ean];
    const name = labelInfo
      ? labelInfo.name
      : (item.type === 'D' ? producerName : ean.slice(-6));
    const entry = { ean, name, type: item.type, monthly: item.monthly };
    if (item.type === 'D') producers.push(entry);
    else consumers.push(entry);
  }

  // Sort consumers by mapping order in XLSX (Společná spotřeba, Byt 1, Byt 2, ...)
  // Use natural order via the helper that returns ordered list.
  consumers.sort((a, b) => {
    // Natural sort: "Společná spotřeba" first, then by Byt number
    const ai = consumerOrder(a.name);
    const bi = consumerOrder(b.name);
    return ai - bi;
  });
  producers.sort((a, b) => a.name.localeCompare(b.name, 'cs'));

  // Per-month totals across the group
  const groupTotals = {};
  for (const m of months) {
    groupTotals[m] = { production: 0, shared: 0, surplus: 0, consumption: 0, received: 0, fromGrid: 0 };
  }

  for (const p of producers) {
    for (const m of months) {
      const v = p.monthly[m];
      if (!v) continue;
      const inV = Math.abs(v.inSum);
      const outV = Math.abs(v.outSum);
      groupTotals[m].production += inV;
      groupTotals[m].shared += (inV - outV);
      groupTotals[m].surplus += outV;
    }
  }
  for (const c of consumers) {
    for (const m of months) {
      const v = c.monthly[m];
      if (!v) continue;
      const inV = Math.abs(v.inSum);
      const outV = Math.abs(v.outSum);
      groupTotals[m].consumption += inV;
      groupTotals[m].received += (inV - outV);
      groupTotals[m].fromGrid += outV;
    }
  }

  return {
    id: group.id,
    label: group.label,
    producers,
    consumers,
    groupTotals,
  };
}

function consumerOrder(name) {
  if (!name) return 9999;
  if (name.toLowerCase().includes('společná')) return 0;
  const m = name.match(/Byt\s+(\d+)/i);
  if (m) return parseInt(m[1]);
  return 9999;
}

function generateHTML(groupBlocks, months) {
  const now = new Date().toLocaleString('cs-CZ');
  const labels = Object.fromEntries(months.map(m => [m, getMonthLabel(m)]));

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sdílení energie - Bobnická</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f0f2f5; color: #1a1a2e; line-height: 1.5; }
  .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 24px 32px; }
  .header h1 { font-size: 24px; font-weight: 600; }
  .header .subtitle { color: #a0aec0; font-size: 14px; margin-top: 4px; }
  .container { max-width: 1400px; margin: 0 auto; padding: 24px; }

  .filter-bar { margin-bottom: 16px; }
  .filter-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items: center; }
  .filter-label { font-size: 13px; font-weight: 600; color: #4a5568; min-width: 50px; }
  .month-btn { padding: 6px 14px; border: 1px solid #e2e8f0; border-radius: 6px; background: white; cursor: pointer; font-size: 13px; }
  .month-btn.active { background: #3182ce; color: white; border-color: #3182ce; }

  .group-section { background: white; border-radius: 12px; padding: 0; margin-bottom: 32px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); overflow: hidden; }
  .group-header { padding: 20px 24px; background: linear-gradient(135deg, #2d3748 0%, #4a5568 100%); color: white; }
  .group-header h2 { font-size: 22px; font-weight: 700; letter-spacing: 0.3px; }
  .group-header .group-sub { color: #cbd5e0; font-size: 13px; margin-top: 4px; }
  .group-body { padding: 24px; }

  .cards-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .card-group { background: #f7fafc; border-radius: 10px; padding: 16px; border: 1px solid #e2e8f0; }
  .card-group .group-title { font-size: 12px; text-transform: uppercase; color: #718096; letter-spacing: 0.5px; font-weight: 700; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid #e2e8f0; }
  .metrics { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .metric .label { font-size: 11px; color: #a0aec0; font-weight: 600; }
  .metric .value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .metric .unit { font-size: 12px; color: #718096; font-weight: 400; }
  .metric.green .value { color: #38a169; }
  .metric.blue .value { color: #3182ce; }
  .metric.orange .value { color: #dd6b20; }
  .metric.purple .value { color: #805ad5; }
  @media (max-width: 900px) { .cards-grid { grid-template-columns: 1fr; } }

  .subsection { margin-bottom: 20px; }
  .subsection h3 { font-size: 15px; font-weight: 600; margin-bottom: 10px; color: #2d3748; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f7fafc; text-align: left; padding: 10px 12px; font-weight: 600; color: #4a5568; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
  td { padding: 8px 12px; border-bottom: 1px solid #edf2f7; }
  tr:hover td { background: #f7fafc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .eff { font-weight: 600; }
  .eff-high { color: #38a169; }
  .eff-mid { color: #dd6b20; }
  .eff-low { color: #e53e3e; }
  .table-scroll { overflow-x: auto; }
  .total-row td { font-weight: 700; background: #f7fafc !important; border-top: 2px solid #e2e8f0; }

  @media (max-width: 768px) {
    .container { padding: 12px; }
    .group-body { padding: 16px; }
    table { font-size: 11px; }
    th, td { padding: 6px 8px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>Sdílení energie - Bobnická</h1>
  <div class="subtitle">Vygenerováno: ${now} | Data: ${months.map(getMonthLabel).join(', ') || '(žádná data)'}</div>
</div>

<div class="container">

<div class="filter-bar">
  <div class="filter-row" id="year-filter"></div>
  <div class="filter-row" id="month-filter"></div>
</div>

<div id="groups-container"></div>

</div>

<script>
const months = ${JSON.stringify(months)};
const monthLabels = ${JSON.stringify(labels)};
const groupBlocks = ${JSON.stringify(groupBlocks)};

const years = [...new Set(months.map(m => m.split('-')[0]))].sort();
const monthNames = ['', 'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
  'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];

let selectedYear = 'all';
let selectedMonth = 'all';

function fmt(n) {
  const parts = n.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  return parts.join(',');
}
function effClass(pct) { return pct >= 50 ? 'eff-high' : pct >= 20 ? 'eff-mid' : 'eff-low'; }

function activeMonths() {
  return months.filter(m => {
    const [y, mo] = m.split('-');
    if (selectedYear !== 'all' && y !== selectedYear) return false;
    if (selectedMonth !== 'all' && mo !== selectedMonth) return false;
    return true;
  });
}

function visibleColumns() {
  if (selectedYear !== 'all' && selectedMonth === 'all') {
    return months.filter(m => m.startsWith(selectedYear));
  }
  if (selectedYear === 'all' && selectedMonth === 'all') return months;
  return [];
}

function renderFilters() {
  const yEl = document.getElementById('year-filter');
  let yHtml = '<span class="filter-label">Rok:</span>';
  yHtml += '<button class="month-btn ' + (selectedYear === 'all' ? 'active' : '') + '" onclick="selectYear(\\'all\\')">Vše</button>';
  for (const y of years) {
    yHtml += '<button class="month-btn ' + (selectedYear === y ? 'active' : '') + '" onclick="selectYear(\\'' + y + '\\')">' + y + '</button>';
  }
  yEl.innerHTML = yHtml;

  const mEl = document.getElementById('month-filter');
  const monthNums = new Set();
  for (const m of months) {
    const [y, mo] = m.split('-');
    if (selectedYear === 'all' || y === selectedYear) monthNums.add(mo);
  }
  let mHtml = '<span class="filter-label">Měsíc:</span>';
  mHtml += '<button class="month-btn ' + (selectedMonth === 'all' ? 'active' : '') + '" onclick="selectMonthNum(\\'all\\')">Vše</button>';
  for (const mo of [...monthNums].sort()) {
    mHtml += '<button class="month-btn ' + (selectedMonth === mo ? 'active' : '') + '" onclick="selectMonthNum(\\'' + mo + '\\')">' + monthNames[parseInt(mo)] + '</button>';
  }
  mEl.innerHTML = mHtml;
}

function selectYear(y) { selectedYear = y; selectedMonth = 'all'; renderAll(); }
function selectMonthNum(mo) { selectedMonth = mo; renderAll(); }

function aggForMonths(monthly, ms, neg) {
  let inSum = 0, outSum = 0;
  for (const m of ms) {
    if (!monthly[m]) continue;
    inSum += Math.abs(monthly[m].inSum);
    outSum += Math.abs(monthly[m].outSum);
  }
  return { inSum, outSum, diff: inSum - outSum };
}

function renderGroupSummary(g) {
  const ms = activeMonths();
  let prod = 0, shared = 0, cons = 0, received = 0;
  for (const m of ms) {
    if (!g.groupTotals[m]) continue;
    prod += g.groupTotals[m].production;
    shared += g.groupTotals[m].shared;
    cons += g.groupTotals[m].consumption;
    received += g.groupTotals[m].received;
  }
  const prodEff = prod > 0 ? shared / prod * 100 : 0;
  const consEff = cons > 0 ? received / cons * 100 : 0;

  return '<div class="cards-grid">' +
    '<div class="card-group"><div class="group-title">Výroba (FVE)</div><div class="metrics">' +
      '<div class="metric blue"><div class="label">Celková výroba</div><div class="value">' + fmt(prod) + ' <span class="unit">kWh</span></div></div>' +
      '<div class="metric green"><div class="label">Nasdíleno</div><div class="value">' + fmt(shared) + ' <span class="unit">kWh</span></div></div>' +
      '<div class="metric orange"><div class="label">Efektivita</div><div class="value">' + fmt(prodEff) + ' <span class="unit">%</span></div></div>' +
    '</div></div>' +
    '<div class="card-group"><div class="group-title">Spotřeba bytů + společná</div><div class="metrics">' +
      '<div class="metric purple"><div class="label">Celková spotřeba</div><div class="value">' + fmt(cons) + ' <span class="unit">kWh</span></div></div>' +
      '<div class="metric green"><div class="label">Přijato sdílením</div><div class="value">' + fmt(received) + ' <span class="unit">kWh</span></div></div>' +
      '<div class="metric orange"><div class="label">Pokrytí</div><div class="value">' + fmt(consEff) + ' <span class="unit">%</span></div></div>' +
    '</div></div>' +
    '</div>';
}

function renderProducersTable(g) {
  const ms = activeMonths();
  const visCols = visibleColumns();
  let html = '<table><thead><tr><th>Výrobna</th>';
  for (const m of visCols) html += '<th class="num">' + monthLabels[m] + '</th>';
  html += '<th class="num">Výroba (kWh)</th><th class="num">Nasdíleno (kWh)</th><th class="num">Přebytek (kWh)</th><th class="num">Efektivita</th></tr></thead><tbody>';

  let totProd = 0, totShared = 0, totSurplus = 0;
  for (const p of g.producers) {
    const a = aggForMonths(p.monthly, ms);
    totProd += a.inSum; totShared += a.diff; totSurplus += a.outSum;
    html += '<tr><td>' + p.name + '</td>';
    for (const m of visCols) {
      const mm = aggForMonths(p.monthly, [m]);
      html += '<td class="num">' + fmt(mm.diff) + '</td>';
    }
    const eff = a.inSum > 0 ? a.diff / a.inSum * 100 : 0;
    html += '<td class="num">' + fmt(a.inSum) + '</td><td class="num">' + fmt(a.diff) + '</td><td class="num">' + fmt(a.outSum) + '</td>';
    html += '<td class="num eff ' + effClass(eff) + '">' + fmt(eff) + ' %</td></tr>';
  }
  if (g.producers.length === 0) {
    html += '<tr><td colspan="' + (5 + visCols.length) + '" style="color:#a0aec0;text-align:center">Žádná data o výrobě</td></tr>';
  } else {
    const totEff = totProd > 0 ? totShared / totProd * 100 : 0;
    html += '<tr class="total-row"><td><strong>Celkem</strong></td>';
    for (const m of visCols) {
      let mm = 0;
      for (const p of g.producers) { mm += aggForMonths(p.monthly, [m]).diff; }
      html += '<td class="num">' + fmt(mm) + '</td>';
    }
    html += '<td class="num">' + fmt(totProd) + '</td><td class="num">' + fmt(totShared) + '</td><td class="num">' + fmt(totSurplus) + '</td>';
    html += '<td class="num eff ' + effClass(totEff) + '">' + fmt(totEff) + ' %</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderConsumersTable(g) {
  const ms = activeMonths();
  const visCols = visibleColumns();
  let html = '<table><thead><tr><th>Odběrné místo</th>';
  for (const m of visCols) html += '<th class="num">' + monthLabels[m] + '</th>';
  html += '<th class="num">Spotřeba (kWh)</th><th class="num">Nasdíleno (kWh)</th><th class="num">Ze sítě (kWh)</th><th class="num">Pokrytí</th></tr></thead><tbody>';

  let totCons = 0, totRcv = 0, totGrid = 0;
  for (const c of g.consumers) {
    const a = aggForMonths(c.monthly, ms);
    totCons += a.inSum; totRcv += a.diff; totGrid += a.outSum;
    html += '<tr><td>' + c.name + '</td>';
    for (const m of visCols) {
      const mm = aggForMonths(c.monthly, [m]);
      html += '<td class="num">' + fmt(mm.diff) + '</td>';
    }
    const eff = a.inSum > 0 ? a.diff / a.inSum * 100 : 0;
    html += '<td class="num">' + fmt(a.inSum) + '</td><td class="num">' + fmt(a.diff) + '</td><td class="num">' + fmt(a.outSum) + '</td>';
    html += '<td class="num eff ' + effClass(eff) + '">' + fmt(eff) + ' %</td></tr>';
  }
  if (g.consumers.length === 0) {
    html += '<tr><td colspan="' + (5 + visCols.length) + '" style="color:#a0aec0;text-align:center">Žádná data o spotřebě</td></tr>';
  } else {
    const totEff = totCons > 0 ? totRcv / totCons * 100 : 0;
    html += '<tr class="total-row"><td><strong>Celkem</strong></td>';
    for (const m of visCols) {
      let mm = 0;
      for (const c of g.consumers) { mm += aggForMonths(c.monthly, [m]).diff; }
      html += '<td class="num">' + fmt(mm) + '</td>';
    }
    html += '<td class="num">' + fmt(totCons) + '</td><td class="num">' + fmt(totRcv) + '</td><td class="num">' + fmt(totGrid) + '</td>';
    html += '<td class="num eff ' + effClass(totEff) + '">' + fmt(totEff) + ' %</td></tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderGroup(g) {
  return '<div class="group-section">' +
    '<div class="group-header"><h2>' + g.label + '</h2><div class="group-sub">Skupina sdílení ' + g.id + '</div></div>' +
    '<div class="group-body">' +
      renderGroupSummary(g) +
      '<div class="subsection"><h3>Výrobna</h3><div class="table-scroll">' + renderProducersTable(g) + '</div></div>' +
      '<div class="subsection"><h3>Odběrná místa</h3><div class="table-scroll">' + renderConsumersTable(g) + '</div></div>' +
    '</div>' +
  '</div>';
}

function renderAll() {
  renderFilters();
  document.getElementById('groups-container').innerHTML =
    groupBlocks.map(renderGroup).join('');
}

renderAll();
</script>
</body>
</html>`;
}

// ──────────────────── MAIN ────────────────────
function main() {
  console.log('Načítám mapování EAN -> názvy...');
  const { eanLabels, groups } = readEanMapping();
  console.log(`  Načteno ${Object.keys(eanLabels).length} EAN názvů`);

  console.log('Načítám CSV exporty...');
  const rows = parseAllCsvFiles();
  console.log(`  Řádků: ${rows.length}`);

  const aggregated = aggregate(rows);

  // Collect all months
  const monthSet = new Set();
  for (const groupId of Object.keys(aggregated)) {
    for (const ean of Object.keys(aggregated[groupId])) {
      for (const m of Object.keys(aggregated[groupId][ean].monthly)) monthSet.add(m);
    }
  }
  const months = [...monthSet].sort();
  console.log(`  Měsíce: ${months.map(getMonthLabel).join(', ') || '(žádné)'}`);

  const groupBlocks = groups.map(g => buildGroupBlock(g, aggregated[g.id] || {}, eanLabels, months, g.producerName));

  console.log('Generuji HTML report...');
  const html = generateHTML(groupBlocks, months);
  fs.writeFileSync(OUTPUT_HTML, html, 'utf-8');
  console.log(`  Uložen: ${OUTPUT_HTML}`);
  console.log('Hotovo!');
}

main();
