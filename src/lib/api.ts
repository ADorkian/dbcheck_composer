import type {
  ConnectionProfile,
  DbCheckCatalogResponse,
  DbCheckPerimeterGenerationRequest,
  DbCheckPerimeterGenerationResult,
  RegressionConfigResponse,
  RegressionExecutionResultDTO
} from '../types';

export interface TpSqlResolveResponse {
  source: 'text' | 'files' | 'none';
  tables: string[];
  rootPath: string;
  matchedFiles: string[];
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function buildBaseUrl(profile: Pick<ConnectionProfile, 'host' | 'port' | 'ctxRoot'>): string {
  const rawHost = profile.host.trim();
  const rawPort = profile.port.trim();
  const rawCtxRoot = profile.ctxRoot.trim().replace(/^\/+/, '');

  if (/^https?:\/\//i.test(rawHost)) {
    const parsed = new URL(rawHost);
    const protocol = parsed.protocol || 'http:';
    const host = parsed.hostname;
    const port = rawPort || parsed.port;
    const inferredCtxRoot = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const ctxRoot = rawCtxRoot || inferredCtxRoot;
    const portSegment = port ? `:${port}` : '';
    const ctxSegment = ctxRoot ? `/${ctxRoot}` : '';
    return trimSlash(`${protocol}//${host}${portSegment}${ctxSegment}`);
  }

  const portSegment = rawPort ? `:${rawPort}` : '';
  const ctxSegment = rawCtxRoot ? `/${rawCtxRoot}` : '';
  return trimSlash(`http://${rawHost}${portSegment}${ctxSegment}`);
}

function encodeBasicAuth(username: string, password: string): string {
  const source = `${username}:${password}`;
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function parseTokenFromBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error('Empty auth response body');
  }

  try {
    const parsed = JSON.parse(trimmed) as { token?: string } | string;
    if (typeof parsed === 'string' && parsed.trim()) {
      return parsed.trim();
    }
    if (typeof parsed === 'object' && parsed && typeof parsed.token === 'string' && parsed.token.trim()) {
      return parsed.token.trim();
    }
  } catch {
    // Fallback handled below.
  }

  if (/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(`Unable to parse auth token from response: ${trimmed}`);
}

async function requestText(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: string }> {
  const requestUrl = import.meta.env.DEV ? `/__proxy?target=${encodeURIComponent(url)}` : url;
  try {
    const response = await fetch(requestUrl, init);
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    throw new Error(`Request failed for ${url} (via ${requestUrl}): ${String(error)}`);
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const resp = await requestText(url, init);
  if (!resp.ok) {
    throw new Error(`Request failed for ${url} (${resp.status}): ${resp.body}`);
  }

  try {
    return JSON.parse(resp.body) as T;
  } catch (error) {
    throw new Error(`Unable to parse JSON response from ${url}: ${String(error)}. Body: ${resp.body}`);
  }
}

function authHeaders(token: string, isBearer: boolean): Record<string, string> {
  return {
    Authorization: `${isBearer ? 'Bearer' : 'Basic'} ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

export async function authenticate(profile: ConnectionProfile): Promise<{ token: string; raw: string }> {
  const basicAuthToken = encodeBasicAuth(profile.username, profile.password);
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/auth/v1/authentication`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(basicAuthToken, false)
  });

  if (!resp.ok) {
    throw new Error(`Auth failed for ${url} (${resp.status}): ${resp.body}`);
  }

  const token = parseTokenFromBody(resp.body);
  return { token, raw: resp.body };
}

export async function runDirect(profile: ConnectionProfile, token: string): Promise<string> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/runRT`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });

  if (!resp.ok) {
    throw new Error(`runRT failed for ${url} (${resp.status}): ${resp.body}`);
  }
  return resp.body.trim();
}

export async function runScheduled(profile: ConnectionProfile, token: string): Promise<string> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/testRT`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });

  if (!resp.ok) {
    throw new Error(`testRT failed for ${url} (${resp.status}): ${resp.body}`);
  }
  return resp.body.trim();
}

export async function pollStatus(profile: ConnectionProfile, token: string, oid: string): Promise<string> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/statusSched?oid=${encodeURIComponent(oid)}`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });

  if (!resp.ok) {
    throw new Error(`statusSched failed for ${url} (${resp.status}): ${resp.body}`);
  }
  return resp.body.trim();
}

export async function checkResult(profile: ConnectionProfile, token: string, oid: string, execDate: string): Promise<string> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/checkResult?oid=${encodeURIComponent(oid)}&dataEsecuzione=${encodeURIComponent(execDate)}`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });

  if (!resp.ok) {
    throw new Error(`checkResult failed for ${url} (${resp.status}): ${resp.body}`);
  }
  return resp.body.trim();
}

export async function getRegressionResult(
  profile: ConnectionProfile,
  token: string,
  oid: string,
  execDate: string
): Promise<RegressionExecutionResultDTO> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/regressionResult?oid=${encodeURIComponent(oid)}&dataEsecuzione=${encodeURIComponent(execDate)}`;
  return requestJson<RegressionExecutionResultDTO>(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });
}

export async function readRegressionConfig(
  profile: ConnectionProfile,
  token: string,
  oid = ''
): Promise<RegressionConfigResponse> {
  const baseUrl = buildBaseUrl(profile);
  const oidQuery = oid.trim() ? `?oid=${encodeURIComponent(oid)}` : '';
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/regressionConfig${oidQuery}`;
  return requestJson<RegressionConfigResponse>(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });
}

export async function upsertRegressionConfig(
  profile: ConnectionProfile,
  token: string,
  parameters: Record<string, unknown>,
  oid = ''
): Promise<RegressionConfigResponse> {
  const baseUrl = buildBaseUrl(profile);
  const oidQuery = oid.trim() ? `?oid=${encodeURIComponent(oid)}` : '';
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/regressionConfig${oidQuery}`;
  return requestJson<RegressionConfigResponse>(url, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(parameters)
  });
}

export async function generateDbCheckPerimeter(
  profile: ConnectionProfile,
  token: string,
  request: DbCheckPerimeterGenerationRequest
): Promise<DbCheckPerimeterGenerationResult> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/dbcheckPerimeter`;
  return requestJson<DbCheckPerimeterGenerationResult>(url, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(request)
  });
}

export async function listDbCheckCatalogResources(
  profile: ConnectionProfile,
  token: string,
  filter = '',
  limit = 5000
): Promise<DbCheckCatalogResponse> {
  const baseUrl = buildBaseUrl(profile);
  const params = new URLSearchParams();
  if (filter.trim()) {
    params.set('filter', filter.trim());
  }
  params.set('limit', String(limit));
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/regressiontest/dbcheck/catalogResources?${params.toString()}`;
  return requestJson<DbCheckCatalogResponse>(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });
}

export async function listLocalDbCheckCatalogResources(filter = '', limit = 5000): Promise<DbCheckCatalogResponse> {
  const params = new URLSearchParams();
  if (filter.trim()) {
    params.set('filter', filter.trim());
  }
  params.set('limit', String(limit));
  const response = await fetch(`/__local/dbcheck/catalogResources?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<DbCheckCatalogResponse>;
}

export async function listDbCheckRegressionResources(
  profile: ConnectionProfile,
  token: string,
  filter = '',
  limit = 5000
): Promise<DbCheckCatalogResponse> {
  const baseUrl = buildBaseUrl(profile);
  const params = new URLSearchParams();
  if (filter.trim()) {
    params.set('filter', filter.trim());
  }
  params.set('limit', String(limit));
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/regressiontest/dbcheck/regressionResources?${params.toString()}`;
  return requestJson<DbCheckCatalogResponse>(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });
}

export async function listLocalDbCheckRegressionResources(filter = '', limit = 5000): Promise<DbCheckCatalogResponse> {
  const params = new URLSearchParams();
  if (filter.trim()) {
    params.set('filter', filter.trim());
  }
  params.set('limit', String(limit));
  const response = await fetch(`/__local/dbcheck/regressionResources?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<DbCheckCatalogResponse>;
}

export async function verifyRun(profile: ConnectionProfile, token: string, nameFile: string): Promise<string> {
  const baseUrl = buildBaseUrl(profile);
  const url = `${baseUrl}/ws/rest/public/v1/${encodeURIComponent(profile.db)}/verifyRT?nameFile=${encodeURIComponent(nameFile)}`;
  const resp = await requestText(url, {
    method: 'GET',
    headers: authHeaders(token, true)
  });

  const body = resp.body.trim();
  if (!resp.ok) {
    throw new Error(`verifyRT failed for ${url} (${resp.status}): ${resp.body}`);
  }
  return body;
}

export async function resolveTpSqlTables(text: string, query = '', fileLimit = 12): Promise<TpSqlResolveResponse> {
  const response = await fetch('/__local/tpsql/resolveTables', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text, query, fileLimit })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<TpSqlResolveResponse>;
}

export async function readLocalAkeronLog(logPath: string, tail = 2000): Promise<string> {
  const params = new URLSearchParams();
  if (logPath.trim()) {
    params.set('path', logPath.trim());
  }
  params.set('tail', String(tail));

  const response = await fetch(`/__local/akeronLog?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'text/plain' }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(body || `HTTP ${response.status}`);
  }

  return body;
}

export async function readLocalTpSqlScript(scriptPath: string): Promise<string> {
  const params = new URLSearchParams();
  params.set('path', scriptPath.trim());

  const response = await fetch(`/__local/tpsql/readScript?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'text/plain' }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(body || `HTTP ${response.status}`);
  }

  return body;
}
