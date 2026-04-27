import type { RegressionDraft } from '../types';

export interface SqlOracleFixture {
  table: string;
  sourceTable: string;
  columns: string[];
  rows: string[][];
}

function cleanLogLine(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function parseKeyValuesFromLines(lines: string[]): Record<string, string> {
  return lines.reduce<Record<string, string>>((acc, rawLine) => {
    const line = cleanLogLine(rawLine);
    if (!line || line.startsWith('--') || line.startsWith('#')) return acc;

    const match = line.match(/(?:^|[\s|;])([A-Za-z0-9_.-]+)\s*=\s*(.+)\s*$/);
    if (!match?.[1]) return acc;

    const key = match[1].trim();
    const value = match[2].trim();
    if (key) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

export function parseKeyValues(text: string): Record<string, string> {
  return parseKeyValuesFromLines(text.split(/\r?\n/));
}

export function extractLaunchParamsFromRuntimeLog(text: string): { params: Record<string, string>; fromStampedBlock: boolean } {
  const lines = text.split(/\r?\n/);
  const beginRegex = /STAMPA\s+PARAMETRI\s*:\s*INIZI?O/i;
  const endRegex = /STAMPA\s+PARAMETRI\s*:\s*FINE/i;

  let inBlock = false;
  const blockLines: string[] = [];
  for (const rawLine of lines) {
    const line = cleanLogLine(rawLine);
    if (beginRegex.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && endRegex.test(line)) {
      break;
    }
    if (inBlock) {
      blockLines.push(rawLine);
    }
  }

  if (blockLines.length) {
    return { params: parseKeyValuesFromLines(blockLines), fromStampedBlock: true };
  }

  // Fallback: parse full pasted content.
  const fallback = parseKeyValuesFromLines(lines);
  if (Object.keys(fallback).length) {
    return { params: fallback, fromStampedBlock: false };
  }

  // Last fallback for SQL N'...properties...' payloads.
  const fromSqlBlob = [...text.matchAll(/N'([^']*)'/g)].map((match) => match[1]).join('\n');
  if (fromSqlBlob.trim()) {
    return { params: parseKeyValues(fromSqlBlob), fromStampedBlock: false };
  }

  return { params: {}, fromStampedBlock: false };
}

function normalizeTableName(name: string): string {
  const compact = name.trim().replace(/[;,)]$/, '');
  const unquoted = compact.replace(/[[\]`"]/g, '');
  const parts = unquoted.split('.').map((entry) => entry.trim()).filter(Boolean);
  return (parts[parts.length - 1] ?? unquoted).trim();
}

export function extractTablesFromText(text: string): string[] {
  const tables = new Set<string>();
  const identifier = '(?:\\[[^\\]]+\\]|[A-Za-z0-9_]+)';
  const qualifiedIdentifier = `(${identifier}(?:\\.${identifier}){0,2})`;
  const patterns = [
    new RegExp(`select\\s+\\*\\s+into\\s+${qualifiedIdentifier}`, 'gi'),
    new RegExp(`insert\\s+into\\s+${qualifiedIdentifier}`, 'gi'),
    new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${qualifiedIdentifier}`, 'gi')
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        tables.add(normalizeTableName(match[1]));
      }
    }
  }

  return [...tables];
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "'") {
      if (inString && next === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) continue;
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitSqlList(listText: string): string[] {
  const values: string[] = [];
  let inString = false;
  let depth = 0;
  let current = '';

  for (let index = 0; index < listText.length; index += 1) {
    const char = listText[index];
    const next = listText[index + 1];
    if (char === "'") {
      current += char;
      if (inString && next === "'") {
        current += next;
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (!inString) {
      if (char === '(') depth += 1;
      if (char === ')') depth = Math.max(0, depth - 1);
      if (char === ',' && depth === 0) {
        values.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) values.push(current.trim());
  return values;
}

function cleanSqlValue(value: string): string {
  const trimmed = value.trim();
  if (/^null$/i.test(trimmed)) return 'NULL';
  const stringMatch = trimmed.match(/^N?'([^]*)'$/i);
  if (stringMatch?.[1] != null) {
    return stringMatch[1].replace(/''/g, "'");
  }
  return trimmed;
}

export function extractOracleFixturesFromSql(text: string): SqlOracleFixture[] {
  const fixtures = new Map<string, SqlOracleFixture>();
  const insertRegex = /INSERT\s+INTO\s+([\[\]\w.]+)\s*\(/gi;
  let match: RegExpExecArray | null = insertRegex.exec(text);

  while (match) {
    const rawTable = match[1];
    const table = normalizeTableName(rawTable);
    const columnsOpenIndex = insertRegex.lastIndex - 1;
    const columnsCloseIndex = findMatchingParen(text, columnsOpenIndex);
    if (columnsCloseIndex < 0) {
      match = insertRegex.exec(text);
      continue;
    }

    const valuesMatch = /\bVALUES\s*\(/i.exec(text.slice(columnsCloseIndex + 1, columnsCloseIndex + 120));
    if (!valuesMatch) {
      insertRegex.lastIndex = columnsCloseIndex + 1;
      match = insertRegex.exec(text);
      continue;
    }

    const valuesOpenIndex = columnsCloseIndex + 1 + valuesMatch.index + valuesMatch[0].lastIndexOf('(');
    const valuesCloseIndex = findMatchingParen(text, valuesOpenIndex);
    if (valuesCloseIndex < 0) {
      insertRegex.lastIndex = columnsCloseIndex + 1;
      match = insertRegex.exec(text);
      continue;
    }

    insertRegex.lastIndex = valuesCloseIndex + 1;
    if (!/_ORACOLO$/i.test(table) || /^CONFIG_REGRTEST_ELAB$/i.test(table)) {
      match = insertRegex.exec(text);
      continue;
    }

    const columns = splitSqlList(text.slice(columnsOpenIndex + 1, columnsCloseIndex)).map((column) => normalizeTableName(column));
    const row = splitSqlList(text.slice(valuesOpenIndex + 1, valuesCloseIndex)).map(cleanSqlValue);
    if (columns.length === 0 || row.length === 0) {
      match = insertRegex.exec(text);
      continue;
    }

    const sourceTable = table.replace(/_ORACOLO$/i, '');
    const existing = fixtures.get(table);
    if (existing) {
      existing.rows.push(columns.map((_, index) => row[index] ?? ''));
    } else {
      fixtures.set(table, {
        table,
        sourceTable,
        columns,
        rows: [columns.map((_, index) => row[index] ?? '')]
      });
    }

    match = insertRegex.exec(text);
  }

  return [...fixtures.values()];
}

export function extractLaunchSummaryFromSql(text: string): Record<string, string> {
  const tokens = [...text.matchAll(/N'([^']*)'/g)].map((match) => match[1]);
  const summary: Record<string, string> = {};

  if (tokens[0]) {
    summary.oid = tokens[0];
  }
  if (tokens[1]) {
    summary.parametri = tokens[1];
  }
  if (tokens[2]) {
    summary.task = tokens[2];
  }

  return summary;
}

export function mergeCatalog(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming].map((entry) => entry.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

export function draftFromCatalogEntry(name: string): RegressionDraft['tables'][number] {
  return {
    id: crypto.randomUUID(),
    name,
    sourceKind: 'catalog',
    sourceRef: name,
    compareMode: 'table_equal',
    keyColumns: '',
    columns: ['OID'],
    rows: [['']],
    notes: ''
  };
}

export function extractTablesFromYaml(text: string): string[] {
  const tables = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(?:table|name|sourceTable)\s*:\s*(.+?)\s*$/i);
    if (match?.[1]) {
      tables.add(normalizeTableName(match[1].replace(/['"]/g, '')));
    }
  }
  return [...tables];
}
