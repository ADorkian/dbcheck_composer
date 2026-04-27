import type { IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface CatalogResourceItem {
  resource: string;
  label: string;
  group: string;
}

const DATASET_CATALOG_RELATIVE = path.join(
  'gsd_erw',
  'src',
  'test',
  'conf',
  'com',
  'akeron',
  'spring',
  'tp',
  'regressiontest',
  'dataset-catalog'
);

const REGRESSION_TESTS_RELATIVE = path.join(
  'gsd_erw',
  'src',
  'test',
  'conf',
  'com',
  'akeron',
  'spring',
  'tp',
  'regressiontest',
  'regression-tests'
);

const LEGACY_REGRESSION_SQL_RELATIVE = path.join('scriptSql');
const DEFAULT_AKERON_LOG_PATH = 'C:\\sviluppo\\wildfly-java\\log\\vulki\\akeron.log';
const LOG_READ_CHUNK_BYTES = 4 * 1024 * 1024;
const LOG_PARAM_CONTEXT_BYTES = 12 * 1024 * 1024;

function candidateTpCatalogRoots(): string[] {
  const configured = process.env.TP_DATASET_CATALOG_ROOT?.trim();
  const roots = configured ? configured.split(path.delimiter).filter(Boolean) : [];
  const workspaceSibling = path.resolve(process.cwd(), '..', 'tp', DATASET_CATALOG_RELATIVE);
  const knownLocal = path.resolve('C:\\sviluppo\\devgit\\tp', DATASET_CATALOG_RELATIVE);
  return [...roots, workspaceSibling, knownLocal];
}

function candidateTpRegressionRoots(): string[] {
  const configured = process.env.TP_REGRESSION_TESTS_ROOT?.trim();
  const roots = configured ? configured.split(path.delimiter).filter(Boolean) : [];
  const workspaceSibling = path.resolve(process.cwd(), '..', 'tp', REGRESSION_TESTS_RELATIVE);
  const knownLocal = path.resolve('C:\\sviluppo\\devgit\\tp', REGRESSION_TESTS_RELATIVE);
  return [...roots, workspaceSibling, knownLocal];
}

function candidateLegacyRegressionSqlRoots(): string[] {
  const configured = process.env.REGRESSION_TEST_SQL_ROOT?.trim();
  const roots = configured ? configured.split(path.delimiter).filter(Boolean) : [];
  const workspaceSibling = path.resolve(process.cwd(), '..', 'regression-test', LEGACY_REGRESSION_SQL_RELATIVE);
  const knownLocal = path.resolve('C:\\sviluppo\\devgit\\regression-test', LEGACY_REGRESSION_SQL_RELATIVE);
  return [...roots, workspaceSibling, knownLocal];
}

async function walkCatalogFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) return walkCatalogFiles(root, fullPath);
    const lowerName = entry.name.toLowerCase();
    if (!lowerName.endsWith('.yaml') && !lowerName.endsWith('.yml')) return [];
    return [path.relative(root, fullPath).replace(/\\/g, '/')];
  }));
  return files.flat();
}

async function walkSqlFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) return walkSqlFiles(root, fullPath);
    const lowerName = entry.name.toLowerCase();
    if (!lowerName.endsWith('.sql')) return [];
    return [fullPath];
  }));
  return files.flat();
}

function normalizeSqlTableName(name: string): string {
  const compact = name.trim().replace(/[;,)]$/, '');
  const unquoted = compact.replace(/[[\]`"]/g, '');
  const parts = unquoted.split('.').map((entry) => entry.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? unquoted).trim();
}

function extractTablesFromSqlText(text: string): string[] {
  const tables = new Set<string>();
  const identifier = '(?:\\[[^\\]]+\\]|[A-Za-z0-9_]+)';
  const qualifiedIdentifier = `(${identifier}(?:\\.${identifier}){0,2})`;
  const patterns = [
    new RegExp(`select\\s+\\*\\s+into\\s+${qualifiedIdentifier}`, 'gi'),
    new RegExp(`insert\\s+into\\s+${qualifiedIdentifier}`, 'gi'),
    new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${qualifiedIdentifier}`, 'gi')
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
      const value = match[1];
      if (value) {
        const normalized = normalizeSqlTableName(value);
        if (normalized && !/^CONFIG_REGRTEST_ELAB$/i.test(normalized)) {
          tables.add(normalized);
        }
      }
      match = pattern.exec(text);
    }
  }

  const ordered = Array.from(tables).sort((left, right) => left.localeCompare(right));
  const oracle = ordered.filter((entry) => /_ORACOLO$/i.test(entry));
  const nonOracle = ordered.filter((entry) => !/_ORACOLO$/i.test(entry));
  return oracle.concat(nonOracle);
}

function splitSearchTokens(query: string): string[] {
  return query
    .split(/[^A-Za-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .map((token) => token.toLowerCase());
}

function tailTextLines(text: string, tail: number): string {
  const safeTail = Number.isFinite(tail) && tail > 0 ? Math.min(Math.floor(tail), 50000) : 2000;
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - safeTail)).join('\n');
}

function sliceLatestRuntimeParamBlock(text: string): string | null {
  const beginRegex = /STAMPA\s+PARAMETRI\s*:\s*INIZI?O/gi;
  const endRegex = /STAMPA\s+PARAMETRI\s*:\s*FINE/i;
  let latestBegin = -1;
  let match: RegExpExecArray | null = beginRegex.exec(text);
  while (match) {
    latestBegin = match.index;
    match = beginRegex.exec(text);
  }

  if (latestBegin < 0) return null;

  const fromBegin = text.slice(latestBegin);
  const endMatch = endRegex.exec(fromBegin);
  if (!endMatch) return fromBegin;
  return fromBegin.slice(0, endMatch.index + endMatch[0].length);
}

async function readLatestRuntimeParamBlock(filePath: string, fallbackTail: number): Promise<string> {
  const fileStat = await stat(filePath);
  const handle = await open(filePath, 'r');
  let offset = fileStat.size;
  let suffix = '';

  try {
    while (offset > 0) {
      const bytesToRead = Math.min(LOG_READ_CHUNK_BYTES, offset);
      offset -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      const windowText = buffer.subarray(0, bytesRead).toString('utf8') + suffix;
      const block = sliceLatestRuntimeParamBlock(windowText);
      if (block) return block;
      suffix = windowText.slice(0, LOG_PARAM_CONTEXT_BYTES);
    }
  } finally {
    await handle.close();
  }

  return tailTextLines(suffix, fallbackTail);
}

interface ResolveTpSqlTablesResult {
  source: 'text' | 'files' | 'none';
  tables: string[];
  rootPath: string;
  matchedFiles: string[];
}

async function resolveTpSqlTables(text: string, query: string, fileLimit: number): Promise<ResolveTpSqlTablesResult> {
  const fromText = extractTablesFromSqlText(text);
  if (fromText.length > 0) {
    return {
      source: 'text',
      tables: fromText,
      rootPath: '',
      matchedFiles: []
    };
  }

  const root = candidateLegacyRegressionSqlRoots().find((candidate) => existsSync(candidate));
  if (!root) {
    return { source: 'none', tables: [], rootPath: candidateLegacyRegressionSqlRoots()[0] ?? '', matchedFiles: [] };
  }

  const sqlFiles = await walkSqlFiles(root);
  const tokens = splitSearchTokens(query);
  const maxFiles = Number.isFinite(fileLimit) && fileLimit > 0 ? Math.min(Math.floor(fileLimit), 50) : 12;
  const matched = tokens.length
    ? sqlFiles.filter((file) => {
        const lower = file.toLowerCase();
        return tokens.some((token) => lower.includes(token));
      })
    : sqlFiles;
  const candidateFiles = matched.slice(0, maxFiles);

  const tableSet = new Set<string>();
  const matchedFiles: string[] = [];
  for (const filePath of candidateFiles) {
    try {
      const body = await readFile(filePath, 'utf8');
      const tables = extractTablesFromSqlText(body);
      if (tables.length === 0) continue;
      tables.forEach((table) => tableSet.add(table));
      matchedFiles.push(path.relative(root, filePath).replace(/\\/g, '/'));
    } catch {
      // Ignore unreadable files.
    }
  }

  const tables = Array.from(tableSet);
  return {
    source: tables.length > 0 ? 'files' : 'none',
    tables,
    rootPath: root,
    matchedFiles
  };
}

function toCatalogItem(resource: string): CatalogResourceItem {
  const normalized = resource.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  const dotIndex = fileName.lastIndexOf('.');
  return {
    resource: normalized,
    label: dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName,
    group: normalized.includes('/') ? normalized.slice(0, normalized.indexOf('/')) : ''
  };
}

async function loadLocalCatalogResources(filter: string, limit: number): Promise<{ rootPath: string; resources: CatalogResourceItem[] }> {
  const root = candidateTpCatalogRoots().find((candidate) => existsSync(candidate));
  if (!root) {
    return { rootPath: candidateTpCatalogRoots()[0] ?? '', resources: [] };
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 5000;
  const resources = (await walkCatalogFiles(root))
    .filter((resource) => !normalizedFilter || resource.toLowerCase().includes(normalizedFilter))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, safeLimit)
    .map(toCatalogItem);
  return { rootPath: root, resources };
}

async function loadLocalRegressionResources(filter: string, limit: number): Promise<{ rootPath: string; resources: CatalogResourceItem[] }> {
  const root = candidateTpRegressionRoots().find((candidate) => existsSync(candidate));
  if (!root) {
    return { rootPath: candidateTpRegressionRoots()[0] ?? '', resources: [] };
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 5000;
  const resources = (await walkCatalogFiles(root))
    .filter((resource) => !normalizedFilter || resource.toLowerCase().includes(normalizedFilter))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, safeLimit)
    .map(toCatalogItem);
  return { rootPath: root, resources };
}

const localProxyPlugin = {
  name: 'local-vulki-proxy',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/__local/dbcheck/catalogResources')) {
        try {
          const parsed = new URL(req.url, 'http://localhost');
          const filter = parsed.searchParams.get('filter') || '';
          const limit = Number(parsed.searchParams.get('limit') || '5000');
          const catalog = await loadLocalCatalogResources(filter, limit);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            dbId: 'LOCAL_TP',
            rootPath: catalog.rootPath,
            count: catalog.resources.length,
            resources: catalog.resources
          }));
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`Local catalog request failed: ${String(error)}`);
          return;
        }
      }

      if (req.url?.startsWith('/__local/dbcheck/regressionResources')) {
        try {
          const parsed = new URL(req.url, 'http://localhost');
          const filter = parsed.searchParams.get('filter') || '';
          const limit = Number(parsed.searchParams.get('limit') || '5000');
          const regression = await loadLocalRegressionResources(filter, limit);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            dbId: 'LOCAL_TP',
            rootPath: regression.rootPath,
            count: regression.resources.length,
            resources: regression.resources
          }));
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`Local regression resources request failed: ${String(error)}`);
          return;
        }
      }

      if (req.url?.startsWith('/__docker/logs')) {
        try {
          const parsed = new URL(req.url, 'http://localhost');
          const container = (parsed.searchParams.get('container') || '').trim();
          const tailRaw = parsed.searchParams.get('tail') || '1200';
          const tail = Number.isFinite(Number(tailRaw)) ? Math.max(1, Math.min(20000, Math.floor(Number(tailRaw)))) : 1200;

          if (!container) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Missing container query parameter.');
            return;
          }

          if (!/^[A-Za-z0-9_.:-]+$/.test(container)) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`Invalid container name: ${container}`);
            return;
          }

          const output = await new Promise<string>((resolve, reject) => {
            const child = spawn('docker', ['logs', '--tail', String(tail), container], { windowsHide: true });
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];

            child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            child.on('error', (error) => reject(error));
            child.on('close', (code) => {
              const stdout = Buffer.concat(stdoutChunks).toString('utf8');
              const stderr = Buffer.concat(stderrChunks).toString('utf8');
              const merged = `${stdout}${stderr}`.trim();
              if (code === 0) {
                resolve(merged);
                return;
              }
              reject(new Error(merged || `docker logs failed with exit code ${String(code)}`));
            });
          });

          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(output);
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`Docker logs request failed: ${String(error)}`);
          return;
        }
      }

      if (req.url?.startsWith('/__local/akeronLog')) {
        try {
          const parsed = new URL(req.url, 'http://localhost');
          const rawPath = (parsed.searchParams.get('path') || DEFAULT_AKERON_LOG_PATH).trim();
          const tailRaw = parsed.searchParams.get('tail') || '2000';
          const tail = Number.isFinite(Number(tailRaw)) ? Number(tailRaw) : 2000;

          if (!rawPath) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Missing log path.');
            return;
          }

          const normalizedPath = path.resolve(rawPath);
          if (!existsSync(normalizedPath)) {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`Log file not found: ${normalizedPath}`);
            return;
          }

          const body = await readLatestRuntimeParamBlock(normalizedPath, tail);
          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(body);
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`Akeron log request failed: ${String(error)}`);
          return;
        }
      }

      if (req.url?.startsWith('/__local/tpsql/resolveTables')) {
        try {
          if ((req.method?.toUpperCase() || 'GET') !== 'POST') {
            res.statusCode = 405;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Method not allowed. Use POST.');
            return;
          }

          const rawBody = await readBody(req);
          const payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) as { text?: string; query?: string; fileLimit?: number } : {};
          const text = typeof payload.text === 'string' ? payload.text : '';
          const query = typeof payload.query === 'string' ? payload.query : '';
          const result = await resolveTpSqlTables(text, query, Number(payload.fileLimit ?? 12));
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(result));
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`TP SQL resolve request failed: ${String(error)}`);
          return;
        }
      }

      if (req.url?.startsWith('/__local/tpsql/readScript')) {
        try {
          const parsed = new URL(req.url, 'http://localhost');
          const rawPath = (parsed.searchParams.get('path') || '').trim();
          if (!rawPath) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end('Missing script path.');
            return;
          }

          const normalizedPath = path.resolve(rawPath);
          if (!existsSync(normalizedPath)) {
            res.statusCode = 404;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`TP SQL script not found: ${normalizedPath}`);
            return;
          }

          if (!normalizedPath.toLowerCase().endsWith('.sql')) {
            res.statusCode = 400;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`TP SQL source must be a .sql file: ${normalizedPath}`);
            return;
          }

          const body = await readFile(normalizedPath, 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(body);
          return;
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`TP SQL script read failed: ${String(error)}`);
          return;
        }
      }

      if (!req.url?.startsWith('/__proxy')) {
        next();
        return;
      }

      const method = req.method?.toUpperCase() || 'GET';

      try {
        const parsed = new URL(req.url, 'http://localhost');
        const target = parsed.searchParams.get('target');
        if (!target) {
          res.statusCode = 400;
          res.end('Missing target query parameter.');
          return;
        }

        const targetUrl = new URL(target);
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
          res.statusCode = 400;
          res.end(`Unsupported protocol: ${targetUrl.protocol}`);
          return;
        }

        const headers: Record<string, string> = {};
        const forwardHeader = (name: string) => {
          const value = req.headers[name];
          if (typeof value === 'string' && value) headers[name] = value;
        };
        forwardHeader('authorization');
        forwardHeader('content-type');
        forwardHeader('accept');

        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
        const upstream = await fetch(targetUrl.toString(), { method, headers, body });

        res.statusCode = upstream.status;
        upstream.headers.forEach((value, key) => {
          if (key.toLowerCase() === 'transfer-encoding') return;
          res.setHeader(key, value);
        });
        res.end(await upstream.text());
      } catch (error) {
        res.statusCode = 502;
        res.end(`Proxy request failed: ${String(error)}`);
      }
    });
  }
};

export default defineConfig({
  plugins: [react(), localProxyPlugin],
  server: {
    host: '0.0.0.0',
    port: 8095,
    strictPort: true
  }
});
