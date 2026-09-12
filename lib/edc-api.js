/**
 * EDC Portal API client
 * Handles authentication (Keycloak OIDC + PKCE) and export operations.
 * SSE_ID is supplied per-call so this client can serve multiple sharing groups.
 */
const crypto = require('crypto');

const SSO_BASE = 'https://sso.portal.edc-cr.cz/auth/realms/edc';
const API_BASE = 'https://api.portal.edc-cr.cz/api/v0';
const CLIENT_ID = 'a63c22a3-6e1d-4eac-b383-d06373da046a';
const REDIRECT_URI = 'https://portal.edc-cr.cz/';

function base64url(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function uuid() {
  return crypto.randomUUID();
}

// A single dropped connection to the portal (ConnectTimeoutError against
// sso.portal.edc-cr.cz) used to kill the whole scheduled run, so every call
// goes through a bounded retry with backoff.
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const RETRIABLE_STATUS = new Set([429, 502, 503, 504]);

async function fetchWithRetry(url, options = {}, attempts = MAX_ATTEMPTS) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (!RETRIABLE_STATUS.has(resp.status) || attempt === attempts) return resp;
      await resp.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) break;
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const reason = lastErr.cause?.message || lastErr.message;
    console.warn(`  Sitova chyba (${reason}) - pokus ${attempt}/${attempts}, opakuji za ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
  }
  throw lastErr;
}

// Export API expects plain yyyy-MM-dd; callers build dates with Date.UTC
function ymd(date) {
  return date.toISOString().slice(0, 10);
}

class EdcApi {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }

  async login() {
    if (this.refreshToken) {
      await this.logout().catch(() => {});
    }

    const { verifier, challenge } = generatePkce();
    const state = uuid();

    const authUrl = `${SSO_BASE}/protocol/openid-connect/auth?` + new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const authResp = await fetchWithRetry(authUrl, { redirect: 'manual' });

    if (authResp.status >= 300 && authResp.status < 400) {
      const directLocation = authResp.headers.get('location');
      if (directLocation) {
        const directUrl = new URL(directLocation);
        const directCode = directUrl.searchParams.get('code');
        if (directCode) {
          return this._exchangeCode(directCode, verifier);
        }
      }
    }

    const authHtml = await authResp.text();
    const authCookies = (authResp.headers.getSetCookie?.() || [])
      .map(c => c.split(';')[0]).join('; ');

    let formAction;
    const kcMatch = authHtml.match(/"loginAction"\s*:\s*"([^"]+)"/);
    if (kcMatch) {
      formAction = JSON.parse('"' + kcMatch[1] + '"');
    } else {
      const actionMatch = authHtml.match(/action="([^"]+)"/);
      if (!actionMatch) throw new Error('Could not find login action URL in Keycloak page');
      formAction = actionMatch[1].replace(/&amp;/g, '&');
    }

    const loginResp = await fetchWithRetry(formAction, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': authCookies,
      },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
      }),
      redirect: 'manual',
    });

    const location = loginResp.headers.get('location');
    if (!location) {
      const loginBody = await loginResp.text();
      const summaryMatch = loginBody.match(/"summary"\s*:\s*"([^"]+)"/);
      const errorMsg = summaryMatch ? summaryMatch[1] : `HTTP ${loginResp.status}`;
      throw new Error(`Login failed: ${errorMsg}`);
    }

    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get('code');
    if (!code) {
      const error = redirectUrl.searchParams.get('error_description') || 'Unknown auth error';
      throw new Error(`Login failed: ${error}`);
    }

    return this._exchangeCode(code, verifier);
  }

  async _exchangeCode(code, verifier) {
    const tokenResp = await fetchWithRetry(`${SSO_BASE}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text();
      throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
    }

    const tokens = await tokenResp.json();
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiry = Date.now() + (tokens.expires_in - 30) * 1000;

    return tokens;
  }

  async logout() {
    if (this.refreshToken) {
      await fetch(`${SSO_BASE}/protocol/openid-connect/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          refresh_token: this.refreshToken,
        }),
      }).catch(() => {});
    }
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0;
  }

  async ensureToken() {
    if (!this.accessToken) {
      await this.login();
      return;
    }
    if (Date.now() < this.tokenExpiry) return;

    const resp = await fetchWithRetry(`${SSO_BASE}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        scope: 'openid email roles profile',
        client_id: CLIENT_ID,
      }),
    });

    if (!resp.ok) {
      await this.login();
      return;
    }

    const tokens = await resp.json();
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiry = Date.now() + (tokens.expires_in - 30) * 1000;
  }

  headers(extraHeaders = {}) {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Edc-Contract-Type': 'STANDARD',
      'X-Correlation-ID': uuid(),
      'Accept': 'application/json',
      'Origin': 'https://portal.edc-cr.cz',
      ...extraHeaders,
    };
  }

  async apiCall(url, options = {}) {
    await this.ensureToken();
    const resp = await fetchWithRetry(url, {
      ...options,
      headers: this.headers(options.headers || {}),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${options.method || 'GET'} ${url} failed: ${resp.status} ${text}`);
    }
    return resp;
  }

  async getSseGroups() {
    const resp = await this.apiCall(`${API_BASE}/profiles-data/get-sse`);
    return resp.json();
  }

  // Since 08/2026 the portal splits the export by profile type into two endpoints
  // (/profiles-data/standard/export and /profiles-data/pair/export). The old unified
  // /profiles-data/export-profiles-data returns 404. Body changed too: sseId is a plain
  // number (not an array), dates are yyyy-MM-dd (not ISO timestamps), and inputType /
  // currentEnteredDateTime / profileType are gone.
  async requestExport({ sseId, dateFrom, dateTo, inputData = true, outputData = true, profileType = 'STANDARD', fileName }) {
    if (!sseId) throw new Error('sseId is required');
    const body = {
      calculationType: 'MONTHLY',
      sseId,
      inputData,
      outputData,
      dateFrom: ymd(dateFrom),
      dateTo: ymd(dateTo),
      fileName: fileName || `Export-dat-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-')}`,
      exportAllProfiles: true,
    };

    const segment = profileType === 'PAIR' ? 'pair' : 'standard';
    const resp = await this.apiCall(`${API_BASE}/profiles-data/${segment}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Returns the planned report: {id, name, reportState: "PLANNED", reportType, requested, generated}
    return resp.json();
  }

  // Poll a specific report until it is generated
  async pollReportById(reportId, maxWait = 300000, interval = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const reports = await this.getReports();
      const report = reports.find(r => r.id === reportId);

      if (report) {
        if (report.reportState === 'GENERATED') return report;
        if (report.reportState === 'ERROR') {
          throw new Error(`Report ${reportId} (${report.name}) skoncil chybou`);
        }
      }

      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Report ${reportId} not ready after ${maxWait / 1000}s`);
  }

  async getReports() {
    const resp = await this.apiCall(
      `${API_BASE}/report?page=0&perPage=25&sortBy=requested&sortOrder=desc`
    );
    const data = await resp.json();
    return data.content || data;
  }

  async downloadReport(reportId) {
    const resp = await this.apiCall(`${API_BASE}/report/${reportId}/download`);
    return resp.text();
  }

  async exportAndDownload({ sseId, dateFrom, dateTo, inputData, outputData, profileType, fileName }) {
    // Trigger export — the response carries the planned report's id
    const planned = await this.requestExport({ sseId, dateFrom, dateTo, inputData, outputData, profileType, fileName });
    if (!planned || planned.id == null) {
      throw new Error(`Export nevratil ID reportu: ${JSON.stringify(planned)}`);
    }

    // Poll that specific report until generated
    const report = await this.pollReportById(planned.id);
    const csv = await this.downloadReport(report.id);
    return { csv, reportId: report.id, reportName: report.name || fileName };
  }
}

module.exports = { EdcApi };
