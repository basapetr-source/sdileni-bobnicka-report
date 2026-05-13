/**
 * Lists SSE sharing groups available to the configured EDC account.
 * Run once after first setup to find SSE_ID_A / SSE_ID_B values.
 *
 *   npm run discover
 */
const fs = require('fs');
const path = require('path');
const { EdcApi } = require('./lib/edc-api');

const envPath = path.join(__dirname, '.env');
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

(async () => {
  const u = process.env.EDC_USERNAME;
  const p = process.env.EDC_PASSWORD;
  if (!u || !p) {
    console.error('Chyba: nastav EDC_USERNAME a EDC_PASSWORD v .env');
    process.exit(1);
  }

  const api = new EdcApi(u, p);
  console.log('Prihlasovani k EDC portalu...');
  await api.login();
  console.log('  OK\n');

  console.log('Stahuji seznam SSE skupin...');
  const groups = await api.getSseGroups();
  console.log(JSON.stringify(groups, null, 2));

  await api.logout().catch(() => {});
})().catch(err => {
  console.error('CHYBA:', err.message);
  process.exit(1);
});
