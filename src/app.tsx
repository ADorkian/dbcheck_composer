import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clipboard,
  Copy,
  Database,
  Download,
  FileInput,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Table2,
  Trash2
} from 'lucide-react';
import {
  authenticate,
  buildBaseUrl,
  checkResult,
  getRegressionResult,
  listDbCheckCatalogResources,
  listLocalDbCheckCatalogResources,
  listDbCheckRegressionResources,
  listLocalDbCheckRegressionResources,
  pollStatus,
  readRegressionConfig,
  readLocalAkeronLog,
  readLocalTpSqlScript,
  resolveTpSqlTables,
  runDirect,
  runScheduled,
  upsertRegressionConfig,
  verifyRun
} from './lib/api';
import {
  buildDbCheckLaunchParams,
  buildDbCheckParametriText,
  createBlankDbCheckConfig,
  createScorecardDbCheckSample,
  normalizeDbCheckConfig,
  validateDbCheckConfig
} from './lib/dbcheck';
import { buildDraftJson, buildMissingArtifactsPrompt, buildPromptBundle, copyText, downloadText } from './lib/prompt';
import { clearWorkspaceState, loadWorkspaceState, saveWorkspaceState } from './lib/storage';
import {
  draftFromCatalogEntry,
  extractOracleFixturesFromSql,
  extractLaunchParamsFromRuntimeLog,
  extractLaunchSummaryFromSql,
  extractTablesFromText,
  extractTablesFromYaml,
  mergeCatalog
} from './lib/parsers';
import type { SqlOracleFixture } from './lib/parsers';
import type {
  ConnectionProfile,
  DbCheckCatalogResource,
  DbCheckConfig,
  LogEntry,
  RegressionConfigResponse,
  RegressionDraft,
  TableDraft,
  TemplateType,
  WorkspaceState
} from './types';

type BannerTone = 'idle' | 'loading' | 'success' | 'error';
type StepId = 'connect' | 'template' | 'tables' | 'run';

const steps: Array<{ id: StepId; label: string; detail: string; Icon: typeof ShieldCheck }> = [
  { id: 'connect', label: 'Connect', detail: 'Auth and profile', Icon: ShieldCheck },
  { id: 'template', label: 'Template', detail: 'Import SQL or YAML', Icon: FileInput },
  { id: 'tables', label: 'Tables', detail: 'Assert data', Icon: Table2 },
  { id: 'run', label: 'Run', detail: 'Launch and inspect', Icon: Play }
];

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createBlankProfile(): ConnectionProfile {
  return {
    id: uid('profile'),
    name: 'Local Vulki',
    host: 'akldevops003',
    port: '8280',
    ctxRoot: 'akeron',
    db: 'RE_CANDIDATE',
    username: '',
    password: '',
    remember: true,
    dockerContainer: '',
    dockerTail: '1200',
    akeronLogPath: 'C:\\sviluppo\\wildfly-java\\log\\vulki\\akeron.log'
  };
}

function createBlankTable(): TableDraft {
  return {
    id: uid('table'),
    name: 'CONTRATTO',
    sourceKind: 'manual',
    sourceRef: '',
    compareMode: 'table_equal',
    keyColumns: 'OID_CONTRATTO',
    columns: ['OID_CONTRATTO', 'STATO_CONTRATTO'],
    rows: [['', '']],
    notes: ''
  };
}

function createBlankDraft(): RegressionDraft {
  return {
    id: uid('draft'),
    name: 'New dbCheck regression',
    description: '',
    templateType: 'TP SQL',
    launchMode: 'direct',
    templateText: '',
    logText: '',
    launchParams: {},
    dbCheckConfig: createBlankDbCheckConfig(),
    tables: [],
    notes: ''
  };
}

function createInitialState(): WorkspaceState {
  return {
    profiles: [createBlankProfile()],
    activeProfileId: '',
    drafts: [createBlankDraft()],
    activeDraftId: '',
    catalog: [],
    resultHistory: []
  };
}

function ensureActiveIds(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    activeProfileId: state.activeProfileId || state.profiles[0]?.id || '',
    activeDraftId: state.activeDraftId || state.drafts[0]?.id || ''
  };
}

function normalizeTable(table: TableDraft): TableDraft {
  const columns = table.columns.filter((col) => col.trim().length > 0);
  const rows = table.rows.map((row) => columns.map((_, index) => row[index] ?? ''));
  return { ...table, columns, rows: rows.length > 0 ? rows : [columns.map(() => '')] };
}

function updateDraftTable(draft: RegressionDraft, tableId: string, updater: (table: TableDraft) => TableDraft): RegressionDraft {
  const tables = toSafeTableArray(draft.tables);
  return {
    ...draft,
    tables: tables.map((table) => (table.id === tableId ? normalizeTable(updater(table)) : table))
  };
}

function formatDateStamp(date = new Date(), separator = '-'): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}${separator}${m}${separator}${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildExecutionDateCandidates(launchParams: Record<string, string>): string[] {
  const base = new Date();
  const candidates = new Set<string>([
    formatDateStamp(base, '_'),
    formatDateStamp(addDays(base, -1), '_'),
    formatDateStamp(addDays(base, 1), '_')
  ]);

  const epochCandidates = [launchParams['e.elabQTS'], launchParams.DATA_CALCOLO]
    .map((value) => Number.parseInt((value || '').trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  for (const epoch of epochCandidates) {
    candidates.add(formatDateStamp(new Date(epoch), '_'));
  }

  return [...candidates];
}

function isPendingStatus(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'WAITING' || normalized === 'RUNNING';
}

function isSuccessStatus(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'SUCCESSO' || normalized === 'SUCCESS' || normalized === 'ENDED' || normalized === 'OK' || normalized === 'PASSED';
}

function normalizeLaunchParams(params: Record<string, string>): Record<string, string> {
  const normalized = { ...params };
  const dbId = params['e.dbId'] || params.db_id || params.dbId;
  if (dbId) normalized.dbId = dbId;
  return normalized;
}

function stepIndex(step: StepId): number {
  return steps.findIndex((entry) => entry.id === step);
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCatalogResourcePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function normalizeRegressionResourcePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^regression-tests\//i, '')
    .toLowerCase();
}

function preferredAssertionTables(tables: string[]): string[] {
  const normalized = mergeCatalog([], tables);
  const filtered = normalized.filter((table) => !/^CONFIG_REGRTEST_ELAB$/i.test(table));
  const oracleTables = filtered.filter((table) => /_ORACOLO$/i.test(table));
  const nonOracleTables = filtered.filter((table) => !/_ORACOLO$/i.test(table));
  return [...oracleTables, ...nonOracleTables];
}

function createTemplateDraftForImportedTable(name: string): TableDraft {
  const normalizedName = name.trim();
  const expectedSource = normalizedName.replace(/_ORACOLO$/i, '');
  return {
    id: uid('table'),
    name: normalizedName,
    sourceKind: 'template',
    sourceRef: normalizedName,
    compareMode: 'table_equal',
    keyColumns: '',
    columns: ['OID'],
    rows: [['']],
    notes: expectedSource !== normalizedName ? `Expected table: ${expectedSource}` : ''
  };
}

function pickFixtureKeyColumns(columns: string[]): string {
  const oidColumns = columns.filter((column) => /^OID($|_)/i.test(column));
  if (oidColumns.includes('OID')) return 'OID';
  return oidColumns.slice(0, 4).join(', ');
}

function createTemplateDraftForSqlFixture(fixture: SqlOracleFixture, sourceScript: string): TableDraft {
  return {
    id: uid('table'),
    name: fixture.table,
    sourceKind: 'template',
    sourceRef: sourceScript || fixture.table,
    compareMode: 'table_equal',
    keyColumns: pickFixtureKeyColumns(fixture.columns),
    columns: fixture.columns,
    rows: fixture.rows.length ? fixture.rows : [fixture.columns.map(() => '')],
    notes: `Expected table: ${fixture.sourceTable}. Imported ${fixture.rows.length} assert row(s).${sourceScript ? ` Source: ${sourceScript}` : ''}`
  };
}

function toSafeTableArray(tables: unknown): TableDraft[] {
  if (!Array.isArray(tables)) return [];
  return tables.filter(Boolean) as TableDraft[];
}

function extractTablesFromCandidateSql(sqlText: string): string[] {
  return preferredAssertionTables(extractTablesFromText(sqlText));
}

function looksLikeTableName(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.includes(' ') || normalized.length < 3) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*(?:_ORACOLO)?$/.test(normalized);
}

function extractTablesFromUnknownPayload(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];

  if (typeof value === 'string') {
    return looksLikeTableName(value) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTablesFromUnknownPayload(entry, depth + 1));
  }

  if (typeof value !== 'object') {
    return [];
  }

  const tables: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      const keyLooksRelevant = /(table|source|oracolo|dataset)/i.test(key);
      if (keyLooksRelevant && looksLikeTableName(entry)) {
        tables.push(entry);
      }
    }
    tables.push(...extractTablesFromUnknownPayload(entry, depth + 1));
  }
  return tables;
}

function hasSelectedRegressionConfig(payload: RegressionConfigResponse | undefined, oid = ''): boolean {
  if (!payload) {
    return false;
  }
  if (payload.selectedConfig) {
    return true;
  }
  const normalizedOid = oid.trim().toUpperCase();
  if (!normalizedOid) {
    return false;
  }
  if (typeof payload.configOid === 'string' && payload.configOid.trim().toUpperCase() === normalizedOid) {
    return true;
  }
  return unknownPayloadContainsOid(payload.activeConfigs, normalizedOid);
}

function unknownPayloadContainsOid(value: unknown, normalizedOid: string, depth = 0): boolean {
  if (depth > 4 || value == null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().toUpperCase() === normalizedOid;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => unknownPayloadContainsOid(entry, normalizedOid, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      unknownPayloadContainsOid(entry, normalizedOid, depth + 1)
    );
  }
  return false;
}

function pickDbIdParams(existing: Record<string, string>, fallbackDbId: string): Record<string, string> {
  const dbId = (existing['e.dbId'] || existing.db_id || existing.dbId || fallbackDbId || '').trim();
  if (!dbId) return {};
  return {
    dbId,
    db_id: dbId,
    'e.dbId': dbId
  };
}

function buildDynamicLaunchParams(
  existing: Record<string, string>,
  config: DbCheckConfig,
  fallbackDbId: string
): Record<string, string> {
  const normalized = normalizeDbCheckConfig(config);
  const params = buildDbCheckLaunchParams(normalized);
  const dbIds = pickDbIdParams(existing, fallbackDbId);
  const taskCode = normalized.taskCode.trim();

  const payload: Record<string, string> = {
    ...dbIds,
    ...(taskCode ? { task: taskCode } : {}),
    ...params
  };

  return payload;
}

function buildDynamicIdentity(config: DbCheckConfig): { task: string; oid: string } {
  const normalized = normalizeDbCheckConfig(config);
  const codElab = normalized.codElab.trim();
  const taskFallback = normalized.taskCode.trim() || 'REGR_TEST';
  const task = codElab || taskFallback;
  return {
    task,
    oid: codElab || task
  };
}

function AppContent() {
  const [state, setState] = useState<WorkspaceState>(() => ensureActiveIds(loadWorkspaceState(createInitialState())));
  const [activeStep, setActiveStep] = useState<StepId>('connect');
  const [templateTab, setTemplateTab] = useState<'import' | 'dynamic'>('import');
  const [selectedImportMode, setSelectedImportMode] = useState<'Auto detect' | 'TP SQL' | 'dbCheck YAML' | 'WildFly log'>('Auto detect');
  const [importText, setImportText] = useState('');
  const [dockerLogLoaded, setDockerLogLoaded] = useState(false);
  const [sourceScriptPath, setSourceScriptPath] = useState('C:\\sviluppo\\devgit\\regression-test\\scriptSql\\ic_01\\DONE\\CAL_PREMI_STEP_FORMULA_TP_8668_001.sql');
  const [sourceScriptLoading, setSourceScriptLoading] = useState(false);
  const [appliedDbCheckParams, setAppliedDbCheckParams] = useState<Record<string, string>>({});
  const [templateGuideOpen, setTemplateGuideOpen] = useState(false);
  const [tableNameInput, setTableNameInput] = useState('');
  const [selectedTableId, setSelectedTableId] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: uid('log'), at: new Date().toISOString(), level: 'info', title: 'Ready', detail: 'Wizard opened.' }
  ]);
  const [authToken, setAuthToken] = useState('');
  const [authBanner, setAuthBanner] = useState<{ tone: BannerTone; title: string; detail: string }>({
    tone: 'idle',
    title: 'Not authenticated',
    detail: 'Fill connection data and authenticate.'
  });
  const [running, setRunning] = useState(false);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [catalogResources, setCatalogResources] = useState<DbCheckCatalogResource[]>([]);
  const [catalogResourceInput, setCatalogResourceInput] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogSource, setCatalogSource] = useState<'none' | 'backend' | 'local'>('none');
  const [regressionResources, setRegressionResources] = useState<DbCheckCatalogResource[]>([]);
  const [regressionLoading, setRegressionLoading] = useState(false);
  const [regressionSource, setRegressionSource] = useState<'none' | 'backend' | 'local'>('none');
  const [toast, setToast] = useState<{ id: string; tone: 'success' | 'error' | 'info'; message: string } | null>(null);
  const cancelRunRef = useRef(false);

  useEffect(() => saveWorkspaceState(state), [state]);
  useEffect(() => () => { cancelRunRef.current = true; }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0];
  const activeDraft = state.drafts.find((draft) => draft.id === state.activeDraftId) ?? state.drafts[0];
  const baseUrl = useMemo(() => (activeProfile ? buildBaseUrl(activeProfile) : ''), [activeProfile]);
  const lastRun = state.resultHistory[0];
  const currentStep = steps.find((step) => step.id === activeStep) ?? steps[0];
  const hasProfile = Boolean(activeProfile?.host && activeProfile.db && activeProfile.username && activeProfile.password);
  const draftTables = toSafeTableArray(activeDraft?.tables);
  const selectedTable = draftTables.find((table) => table.id === selectedTableId) ?? draftTables[0];
  const dbCheckConfig = normalizeDbCheckConfig(activeDraft?.dbCheckConfig);
  const launchParamCodElab = (activeDraft?.launchParams?.['e.codElab'] ?? '').trim();
  const launchParamCatalogResources = (activeDraft?.launchParams?.['dbcheck.catalogResources'] ?? '').trim();
  const launchParamRegressionResource = (activeDraft?.launchParams?.['dbcheck.regressionResource'] ?? '').trim();
  const effectiveDbCheckConfig = normalizeDbCheckConfig({
    ...dbCheckConfig,
    codElab: dbCheckConfig.codElab.trim() || launchParamCodElab,
    catalogResources: dbCheckConfig.catalogResources.trim() || launchParamCatalogResources,
    regressionResource: dbCheckConfig.regressionResource.trim() || launchParamRegressionResource
  });
  const dbCheckMissing = validateDbCheckConfig(effectiveDbCheckConfig);
  const dbCheckParametri = buildDbCheckParametriText(effectiveDbCheckConfig);
  const dbCheckLaunchParams = buildDbCheckLaunchParams(effectiveDbCheckConfig);
  const isDynamicDbCheck = activeDraft?.templateType === 'Dynamic DBCheck';
  const isTpSqlTemplate = activeDraft?.templateType === 'TP SQL' || Boolean(activeDraft?.launchParams?.['tpSql.sourceScript']);
  const hasDynamicContractInput = Boolean(
    effectiveDbCheckConfig.codElab.trim() ||
    effectiveDbCheckConfig.catalogResources.trim() ||
    effectiveDbCheckConfig.regressionResource.trim() ||
    effectiveDbCheckConfig.runtimeText.trim() ||
    effectiveDbCheckConfig.expectedText.trim()
  );
  const shouldUseDynamicFlow = !isTpSqlTemplate && (isDynamicDbCheck || hasDynamicContractInput);
  const isDynamicTemplateTabActive = templateTab === 'dynamic';
  const configuredCatalogResources = splitCsv(effectiveDbCheckConfig.catalogResources);
  const catalogResourceSet = new Set(catalogResources.map((resource) => normalizeCatalogResourcePath(resource.resource)));
  const catalogValidationTrusted = catalogSource === 'backend' || (!authToken && catalogSource === 'local');
  const missingCatalogResources = !catalogValidationTrusted || catalogResources.length === 0
    ? []
    : configuredCatalogResources.filter((resource) => !catalogResourceSet.has(normalizeCatalogResourcePath(resource)));
  const normalizedRegressionResource = normalizeRegressionResourcePath(effectiveDbCheckConfig.regressionResource);
  const regressionResourceSet = new Set(regressionResources.map((resource) => normalizeRegressionResourcePath(resource.resource)));
  const regressionValidationTrusted = regressionSource === 'backend' || (!authToken && regressionSource === 'local');
  const regressionResourceMissing = Boolean(
    regressionValidationTrusted &&
    normalizedRegressionResource &&
    regressionResources.length > 0 &&
    !regressionResourceSet.has(normalizedRegressionResource)
  );
  const dynamicPreflightWarnings = [
    ...(authToken && catalogSource === 'local' ? ['Catalog validation uses local fallback (backend catalog API unavailable).'] : []),
    ...(authToken && regressionSource === 'local' ? ['Regression YAML validation uses local fallback (backend regression API unavailable).'] : []),
    ...(authToken && catalogSource === 'none' ? ['Catalog resources not loaded yet.'] : []),
    ...(authToken && regressionSource === 'none' ? ['Regression resources not loaded yet.'] : [])
  ];
  const dynamicPreflightErrors = [
    ...dbCheckMissing,
    ...missingCatalogResources.map((resource) => `Missing catalog resource: ${resource}`),
    ...(regressionResourceMissing ? [`Missing regression resource: ${effectiveDbCheckConfig.regressionResource}`] : [])
  ];
  const hasDynamicDbCheck = shouldUseDynamicFlow && dynamicPreflightErrors.length === 0;
  const hasTemplate = Boolean(activeDraft?.templateText || activeDraft?.logText || Object.keys(activeDraft?.launchParams ?? {}).length);
  const hasTables = shouldUseDynamicFlow
    ? hasDynamicDbCheck
    : Boolean(draftTables.length && draftTables.every((table) => table.name.trim()));
  const stepErrors: Record<StepId, boolean> = {
    connect: false,
    template: shouldUseDynamicFlow && dynamicPreflightErrors.length > 0,
    tables: false,
    run: shouldUseDynamicFlow && dynamicPreflightErrors.length > 0
  };
  const completed = {
    connect: Boolean(authToken),
    template: hasTemplate && !stepErrors.template,
    tables: hasTables,
    run: Boolean(lastRun) && !stepErrors.run
  };

  useEffect(() => {
    if (!draftTables.length) {
      setSelectedTableId('');
      return;
    }
    if (!draftTables.some((table) => table.id === selectedTableId)) {
      setSelectedTableId(draftTables[0].id);
    }
  }, [activeDraft?.id, draftTables, selectedTableId]);

  useEffect(() => {
    if (!authToken || !activeProfile || !isDynamicTemplateTabActive || catalogResources.length > 0) {
      return;
    }
    void loadDbCheckCatalogResources(false);
  }, [authToken, activeProfile?.id, activeProfile?.db, isDynamicTemplateTabActive, catalogResources.length]);

  useEffect(() => {
    if (!isDynamicTemplateTabActive || regressionResources.length > 0) {
      return;
    }
    void loadRegressionResources(false);
  }, [isDynamicTemplateTabActive, regressionResources.length]);

  useEffect(() => {
    if (!isDynamicTemplateTabActive || !activeDraft) {
      return;
    }

    const patch: Partial<DbCheckConfig> = {};
    if (!dbCheckConfig.codElab.trim() && launchParamCodElab) {
      patch.codElab = launchParamCodElab;
    }
    if (!dbCheckConfig.catalogResources.trim() && launchParamCatalogResources) {
      patch.catalogResources = launchParamCatalogResources;
    }
    if (!dbCheckConfig.regressionResource.trim() && launchParamRegressionResource) {
      patch.regressionResource = launchParamRegressionResource;
    }

    if (Object.keys(patch).length > 0) {
      updateDbCheckConfig(patch);
    }
  }, [
    isDynamicTemplateTabActive,
    activeDraft?.id,
    dbCheckConfig.codElab,
    dbCheckConfig.catalogResources,
    dbCheckConfig.regressionResource,
    dbCheckConfig.runtimeText,
    launchParamCodElab,
    launchParamCatalogResources,
    launchParamRegressionResource
  ]);

  useEffect(() => {
    if (!activeDraft) return;

    const normalizedDynamicConfig = normalizeDbCheckConfig(activeDraft.dbCheckConfig);
    const hasDynamicConfig = Boolean(
      normalizedDynamicConfig.codElab.trim() ||
      normalizedDynamicConfig.catalogResources.trim() ||
      normalizedDynamicConfig.regressionResource.trim() ||
      normalizedDynamicConfig.runtimeText.trim() ||
      normalizedDynamicConfig.expectedText.trim()
    );

    if (activeDraft.templateType === 'Dynamic DBCheck') {
      setTemplateTab('dynamic');
      setAppliedDbCheckParams(buildDbCheckLaunchParams(normalizeDbCheckConfig(activeDraft.dbCheckConfig)));
    } else if (hasDynamicConfig && !activeDraft.templateText.trim()) {
      // Legacy drafts may have dynamic config but old/empty templateType.
      setTemplateTab('dynamic');
      setAppliedDbCheckParams(buildDbCheckLaunchParams(normalizedDynamicConfig));
    } else {
      setTemplateTab('import');
      setAppliedDbCheckParams({});
      const inferredFromText = extractTablesFromText(activeDraft.templateText || '').length > 0 ? 'TP SQL' : undefined;
      if (activeDraft.templateType === 'TP SQL' || activeDraft.templateType === 'dbCheck YAML' || activeDraft.templateType === 'WildFly log') {
        setSelectedImportMode(activeDraft.templateType);
      } else if (inferredFromText) {
        setSelectedImportMode(inferredFromText);
      } else if (activeDraft.logText && !activeDraft.templateText) {
        setSelectedImportMode('WildFly log');
      } else {
        setSelectedImportMode('Auto detect');
      }
    }

    const nextImportText = activeDraft.templateText || activeDraft.logText || '';
    setImportText(nextImportText);
    setDockerLogLoaded(Boolean(nextImportText));
    if (activeDraft.launchParams['tpSql.sourceScript']) {
      setSourceScriptPath(activeDraft.launchParams['tpSql.sourceScript']);
    }
  }, [activeDraft?.id]);

  useEffect(() => {
    if (!activeDraft) return;
    if (activeDraft.templateType !== 'TP SQL') return;
    if (draftTables.length > 0) return;

    const candidates = [activeDraft.templateText || '', importText || '', activeDraft.logText || ''];
    const fixtureCandidate = candidates
      .map((candidate) => extractOracleFixturesFromSql(candidate))
      .find((fixtures) => fixtures.length > 0) ?? [];
    const inferredTables = fixtureCandidate.length
      ? fixtureCandidate.map((fixture) => fixture.table)
      : candidates.map((candidate) => extractTablesFromCandidateSql(candidate)).find((tables) => tables.length > 0) ?? [];
    if (inferredTables.length === 0) return;

    const sourceScript = activeDraft.launchParams['tpSql.sourceScript'] || sourceScriptPath.trim();
    const hydratedTables = fixtureCandidate.length
      ? fixtureCandidate.map((fixture) => createTemplateDraftForSqlFixture(fixture, sourceScript))
      : inferredTables.map((tableName) => createTemplateDraftForImportedTable(tableName));
    updateActiveDraft((draft) => ({ ...draft, tables: [...toSafeTableArray(draft.tables), ...hydratedTables] }));
    setSelectedTableId(hydratedTables[0]?.id ?? '');
    pushLog('info', 'TP SQL tables restored', `${hydratedTables.length} table draft(s) recovered from saved template text.`);
  }, [activeDraft?.id, activeDraft?.templateType, activeDraft?.templateText, activeDraft?.logText, importText, draftTables.length]);

  function canAccessStep(step: StepId): boolean {
    if (step === 'connect') return true;
    if (step === 'template') return Boolean(authToken);
    if (step === 'tables') return Boolean(authToken && hasTemplate);
    return Boolean(authToken && hasTemplate && hasTables);
  }

  function blockedReason(step: StepId): string {
    if (step === 'template' && !authToken) return 'Authenticate before moving to Template.';
    if (step === 'tables' && !authToken) return 'Authenticate before moving to Tables.';
    if (step === 'tables' && !hasTemplate) return 'Import a template before moving to Tables.';
    if (step === 'run' && !authToken) return 'Authenticate before moving to Run.';
    if (step === 'run' && !hasTemplate) return 'Import a template before moving to Run.';
    if (step === 'run' && shouldUseDynamicFlow && !hasDynamicDbCheck) {
      return dynamicPreflightErrors.length
        ? `Fix Dynamic DBCheck preflight: ${dynamicPreflightErrors.slice(0, 2).join(' | ')}`
        : 'Complete Dynamic DBCheck config before moving to Run.';
    }
    if (step === 'run' && !hasTables) return 'Add at least one table before moving to Run.';
    return '';
  }

  function tryMoveToStep(step: StepId) {
    if (!canAccessStep(step)) {
      const reason = blockedReason(step);
      if (reason) pushLog('warn', 'Step locked', reason);
      return;
    }
    setActiveStep(step);
  }

  function pushLog(level: LogEntry['level'], title: string, detail?: string) {
    setLogs((current) => [{ id: uid('log'), at: new Date().toISOString(), level, title, detail }, ...current]);
  }

  function notify(tone: 'success' | 'error' | 'info', message: string) {
    setToast({ id: uid('toast'), tone, message });
  }

  function updateProfile(patch: Partial<ConnectionProfile>) {
    setState((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === current.activeProfileId ? { ...profile, ...patch } : profile
      )
    }));
  }

  function updateDraft(patch: Partial<RegressionDraft>) {
    setState((current) => ({
      ...current,
      drafts: current.drafts.map((draft) => (draft.id === current.activeDraftId ? { ...draft, ...patch } : draft))
    }));
  }

  function updateDbCheckConfig(patch: Partial<NonNullable<RegressionDraft['dbCheckConfig']>>) {
    updateDraft({ dbCheckConfig: { ...dbCheckConfig, ...patch } });
  }

  function updateActiveDraft(updater: (draft: RegressionDraft) => RegressionDraft) {
    setState((current) => ({
      ...current,
      drafts: current.drafts.map((draft) => (draft.id === current.activeDraftId ? updater(draft) : draft))
    }));
  }

  function addDraftTableAndSelect(table?: TableDraft) {
    const nextTable = normalizeTable(table ?? createBlankTable());
    updateActiveDraft((draft) => ({ ...draft, tables: [...toSafeTableArray(draft.tables), nextTable] }));
    setSelectedTableId(nextTable.id);
  }

  function addTableByName(tableName: string) {
    const normalizedName = tableName.trim();
    if (!normalizedName) {
      pushLog('warn', 'Table not added', 'Type or select a table name first.');
      return;
    }

    const existing = draftTables.find((table) => table.name.toLowerCase() === normalizedName.toLowerCase());
    if (existing) {
      setSelectedTableId(existing.id);
      setTableNameInput('');
      return;
    }

    const sourceKind: TableDraft['sourceKind'] = state.catalog.some((table) => table.toLowerCase() === normalizedName.toLowerCase()) ? 'catalog' : 'manual';
    const table = sourceKind === 'catalog'
      ? draftFromCatalogEntry(normalizedName)
      : { ...createBlankTable(), name: normalizedName, sourceKind, sourceRef: normalizedName };
    addDraftTableAndSelect(table);
    setTableNameInput('');
  }

  function addTableFromInput() {
    addTableByName(tableNameInput);
  }

  function removeDraftTable(tableId: string) {
    const remaining = draftTables.filter((table) => table.id !== tableId);
    updateActiveDraft((draft) => ({
      ...draft,
      tables: toSafeTableArray(draft.tables).filter((table) => table.id !== tableId)
    }));
    if (selectedTableId === tableId && remaining.length > 0) {
      setSelectedTableId(remaining[0].id);
    } else if (selectedTableId === tableId) {
      setSelectedTableId('');
    }
  }

  function addProfile() {
    const profile = createBlankProfile();
    setState((current) => ({ ...current, profiles: [profile, ...current.profiles], activeProfileId: profile.id }));
  }

  function addDraft() {
    const draft = createBlankDraft();
    setState((current) => ({ ...current, drafts: [draft, ...current.drafts], activeDraftId: draft.id }));
    notify('success', 'New template created.');
  }

  function duplicateActiveDraft() {
    if (!activeDraft) return;
    const duplicated: RegressionDraft = {
      ...activeDraft,
      id: uid('draft'),
      name: `${activeDraft.name} (copy)`,
      launchParams: { ...activeDraft.launchParams },
      dbCheckConfig: { ...normalizeDbCheckConfig(activeDraft.dbCheckConfig) },
      tables: draftTables.map((table) => ({
        ...table,
        id: uid('table'),
        columns: [...table.columns],
        rows: table.rows.map((row) => [...row])
      }))
    };
    setState((current) => ({ ...current, drafts: [duplicated, ...current.drafts], activeDraftId: duplicated.id }));
    notify('success', 'Template duplicated.');
    pushLog('success', 'Template duplicated', `Created copy: ${duplicated.name}`);
  }

  function removeActiveDraft() {
    if (!activeDraft) return;
    if (state.drafts.length <= 1) {
      notify('error', 'At least one template is required.');
      pushLog('warn', 'Template not removed', 'You must keep at least one template.');
      return;
    }
    const remaining = state.drafts.filter((draft) => draft.id !== state.activeDraftId);
    setState((current) => ({
      ...current,
      drafts: remaining,
      activeDraftId: remaining[0]?.id ?? ''
    }));
    notify('info', `Template "${activeDraft.name}" removed.`);
    pushLog('info', 'Template removed', activeDraft.name);
  }

  function resetWorkspace() {
    clearWorkspaceState();
    setState(ensureActiveIds(createInitialState()));
    setAuthToken('');
    setAuthBanner({ tone: 'idle', title: 'Not authenticated', detail: 'Fill connection data and authenticate.' });
    setActiveStep('connect');
    setTemplateTab('import');
    setDockerLogLoaded(false);
    setAppliedDbCheckParams({});
    setLogs([{ id: uid('log'), at: new Date().toISOString(), level: 'info', title: 'Workspace reset' }]);
  }

  function resetTemplateStep() {
    setTemplateTab('import');
    setSelectedImportMode('Auto detect');
    setImportText('');
    setDockerLogLoaded(false);
    setAppliedDbCheckParams({});
    setCatalogResourceInput('');
    updateDraft({
      templateType: 'Manual',
      templateText: '',
      logText: '',
      launchParams: {},
      dbCheckConfig: createBlankDbCheckConfig()
    });
    pushLog('info', 'Template reset', 'Current draft template config was cleared. Connection, tables, and run history were kept.');
  }

  function addCatalogEntries(entries: string[]) {
    setState((current) => ({ ...current, catalog: mergeCatalog(current.catalog, entries) }));
  }

  function applyImportedTablesToDraft(tableNames: string[]): number {
    if (!activeDraft) return 0;
    const preferredNames = preferredAssertionTables(tableNames);
    if (preferredNames.length === 0) return 0;

    const existingByName = new Map(draftTables.map((table) => [table.name.toLowerCase(), table]));
    const tablesToAdd: TableDraft[] = [];
    let firstSelectionId = '';

    for (const tableName of preferredNames) {
      const key = tableName.toLowerCase();
      const existing = existingByName.get(key);
      if (existing) {
        if (!firstSelectionId) firstSelectionId = existing.id;
        continue;
      }
      const created = createTemplateDraftForImportedTable(tableName);
      tablesToAdd.push(created);
      existingByName.set(key, created);
      if (!firstSelectionId) firstSelectionId = created.id;
    }

    if (tablesToAdd.length > 0) {
      updateActiveDraft((draft) => ({ ...draft, tables: [...toSafeTableArray(draft.tables), ...tablesToAdd] }));
    }
    if (firstSelectionId) {
      setSelectedTableId(firstSelectionId);
    }

    return tablesToAdd.length;
  }

  function applyImportedSqlFixturesToDraft(sqlText: string, sourceScript: string): number {
    if (!activeDraft) return 0;
    const fixtures = extractOracleFixturesFromSql(sqlText);
    if (fixtures.length === 0) return 0;

    const byName = new Map(fixtures.map((fixture) => [fixture.table.toLowerCase(), fixture]));
    let firstSelectionId = '';
    let changedCount = 0;
    const existingNames = new Set(draftTables.map((table) => table.name.toLowerCase()));
    const updatedTables = draftTables.map((table) => {
      const fixture = byName.get(table.name.toLowerCase());
      if (!fixture) return table;
      changedCount += 1;
      const hydrated = createTemplateDraftForSqlFixture(fixture, sourceScript);
      if (!firstSelectionId) firstSelectionId = table.id;
      return { ...hydrated, id: table.id };
    });
    const addedTables = fixtures
      .filter((fixture) => !existingNames.has(fixture.table.toLowerCase()))
      .map((fixture) => {
        const table = createTemplateDraftForSqlFixture(fixture, sourceScript);
        if (!firstSelectionId) firstSelectionId = table.id;
        changedCount += 1;
        return table;
      });

    updateActiveDraft((draft) => ({
      ...draft,
      tables: [...updatedTables, ...addedTables]
    }));
    if (firstSelectionId) setSelectedTableId(firstSelectionId);
    return changedCount;
  }

  async function loadTpSqlSourceScript() {
    if (!activeDraft) {
      pushLog('error', 'Source script failed', 'No active template selected.');
      return;
    }
    const scriptPath = sourceScriptPath.trim();
    if (!scriptPath) {
      pushLog('warn', 'Source script skipped', 'Set TP SQL source script path first.');
      return;
    }

    setSourceScriptLoading(true);
    try {
      const sqlText = await readLocalTpSqlScript(scriptPath);
      setImportText(sqlText);
      setDockerLogLoaded(true);
      setSelectedImportMode('TP SQL');
      const fixtures = extractOracleFixturesFromSql(sqlText);
      const tableNames = preferredAssertionTables(fixtures.map((fixture) => fixture.table));
      const addedDraftTables = applyImportedSqlFixturesToDraft(sqlText, scriptPath);
      const parsedLaunchParams = normalizeLaunchParams(extractLaunchParamsFromRuntimeLog(sqlText).params);
      const sqlSummary = extractLaunchSummaryFromSql(sqlText);
      addCatalogEntries(tableNames);
      updateDraft({
        templateText: sqlText,
        templateType: 'TP SQL',
        dbCheckConfig: createBlankDbCheckConfig(),
        launchParams: {
          ...activeDraft.launchParams,
          ...sqlSummary,
          ...parsedLaunchParams,
          'tpSql.sourceScript': scriptPath
        }
      });
      if (parsedLaunchParams.dbId && activeProfile) updateProfile({ db: parsedLaunchParams.dbId });
      pushLog('success', 'TP SQL source loaded', `${fixtures.length} oracle table fixture(s), ${addedDraftTables} table editor(s), ${fixtures.reduce((sum, fixture) => sum + fixture.rows.length, 0)} assert row(s).`);
      tryMoveToStep('tables');
    } catch (error) {
      pushLog('error', 'Source script failed', String(error));
    } finally {
      setSourceScriptLoading(false);
    }
  }

  async function loadDbCheckCatalogResources(manual: boolean) {
    if (!activeProfile || !authToken) {
      if (manual) pushLog('warn', 'Catalog load skipped', 'Authenticate before loading TP catalog resources.');
      return;
    }
    setCatalogLoading(true);
    try {
      const response = await listDbCheckCatalogResources(activeProfile, authToken, '', 5000);
      const effectiveResponse = response.resources.length > 0 ? response : await listLocalDbCheckCatalogResources('', 5000);
      setCatalogResources(effectiveResponse.resources);
      setCatalogSource(response.resources.length > 0 ? 'backend' : 'local');
      if (manual) {
        const source = response.resources.length > 0 ? 'TP backend' : 'local TP repo fallback';
        pushLog('success', 'Catalog resources loaded', `${effectiveResponse.resources.length} resource(s) from ${source}.`);
      }
    } catch (error) {
      try {
        const localResponse = await listLocalDbCheckCatalogResources('', 5000);
        setCatalogResources(localResponse.resources);
        setCatalogSource('local');
        if (manual) {
          pushLog('success', 'Catalog resources loaded', `${localResponse.resources.length} resource(s) from local TP repo fallback.`);
        }
      } catch (localError) {
        setCatalogSource('none');
        pushLog('warn', 'Catalog resources unavailable', `${String(error)}; local fallback failed: ${String(localError)}`);
      }
    } finally {
      setCatalogLoading(false);
    }
  }

  async function loadRegressionResources(manual: boolean) {
    if (!activeProfile) {
      if (manual) pushLog('warn', 'Regression resources skipped', 'No active profile.');
      return;
    }
    setRegressionLoading(true);
    try {
      let backendResponse: DbCheckCatalogResource[] = [];
      if (authToken) {
        try {
          const response = await listDbCheckRegressionResources(activeProfile, authToken, '', 5000);
          backendResponse = response.resources;
        } catch {
          backendResponse = [];
        }
      }

      const effective = backendResponse.length > 0
        ? { resources: backendResponse, source: 'TP backend' }
        : await listLocalDbCheckRegressionResources('', 5000).then((response) => ({ resources: response.resources, source: 'local TP repo fallback' }));
      setRegressionResources(effective.resources);
      setRegressionSource(backendResponse.length > 0 ? 'backend' : 'local');
      if (manual) {
        pushLog('success', 'Regression resources loaded', `${effective.resources.length} resource(s) from ${effective.source}.`);
      }
    } catch (error) {
      setRegressionResources([]);
      setRegressionSource('none');
      if (manual) pushLog('warn', 'Regression resources unavailable', String(error));
    } finally {
      setRegressionLoading(false);
    }
  }

  function appendCatalogResource() {
    const selected = findCatalogResource(catalogResourceInput);
    const resourceName = selected?.resource ?? catalogResourceInput.trim();
    if (!resourceName) {
      pushLog('warn', 'Catalog resource not added', 'Select or type a catalog resource first.');
      return;
    }

    const currentResources = dbCheckConfig.catalogResources
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const exists = currentResources.some((entry) => entry.toLowerCase() === resourceName.toLowerCase());
    if (!exists) {
      updateDbCheckConfig({ catalogResources: [...currentResources, resourceName].join(', ') });
    }
    setCatalogResourceInput('');
  }

  function findCatalogResource(value: string): DbCheckCatalogResource | undefined {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    return catalogResources.find((resource) =>
      resource.resource.toLowerCase() === normalized || resource.label.toLowerCase() === normalized
    );
  }

  async function copyMissingArtifactsPrompt() {
    if (!activeProfile || !activeDraft) return;
    try {
      const prompt = buildMissingArtifactsPrompt(activeProfile, activeDraft, {
        missingCatalogResources,
        regressionResourceMissing
      });
      await copyText(prompt);
      notify('success', 'BE prompt copied to clipboard.');
      pushLog('success', 'BE prompt copied', 'Prompt for missing catalog/regression YAML artifacts copied to clipboard.');
    } catch (error) {
      notify('error', 'Failed to copy BE prompt.');
      pushLog('error', 'BE prompt copy failed', String(error));
    }
  }

  function applyDbCheckConfig(config = effectiveDbCheckConfig) {
    const normalized = normalizeDbCheckConfig(config);
    const identity = buildDynamicIdentity(normalized);
    const params = buildDynamicLaunchParams(activeDraft?.launchParams ?? {}, normalized, activeProfile?.db ?? '');
    const launchParamsWithIdentity: Record<string, string> = {
      ...params,
      task: identity.task,
      TASK: identity.task,
      oid: identity.oid,
      OID: identity.oid
    };
    const missing = validateDbCheckConfig(normalized);
    setTemplateTab('dynamic');
    setAppliedDbCheckParams(launchParamsWithIdentity);

    updateDraft({
      dbCheckConfig: normalized,
      templateType: 'Dynamic DBCheck',
      launchMode: 'scheduled',
      launchParams: launchParamsWithIdentity,
      templateText: buildDbCheckParametriText(normalized)
    });

    if (normalized.catalogResources.trim()) {
      addCatalogEntries(normalized.catalogResources.split(',').map((entry) => entry.trim()).filter(Boolean));
    }

    if (missing.length) {
      pushLog('warn', 'DBCheck config incomplete', `Missing: ${missing.join(', ')}`);
      return;
    }

    pushLog('success', 'DBCheck config ready', `${Object.keys(launchParamsWithIdentity).length} param(s) generated.`);
  }

  function applyScorecardSample() {
    const sample = createScorecardDbCheckSample();
    setTemplateTab('dynamic');
    updateDraft({ name: 'SCORECARD_DBCHECK dynamic DBCheck', dbCheckConfig: sample });
    applyDbCheckConfig(sample);
  }

  async function resolveTpSqlTablesForImport(text: string): Promise<string[]> {
    const queryParts = [
      activeDraft?.name ?? '',
      activeDraft?.launchParams?.task ?? '',
      activeDraft?.launchParams?.OID ?? '',
      activeDraft?.launchParams?.['e.codElab'] ?? ''
    ].filter(Boolean);

    const directTables = extractTablesFromCandidateSql(text);
    let merged = mergeCatalog([], directTables);

    try {
      const localResolved = await resolveTpSqlTables(text, queryParts.join(' '), 20);
      merged = mergeCatalog(merged, localResolved.tables);
      const sourceLabel =
        localResolved.source === 'text'
          ? 'from parsed SQL text'
          : localResolved.source === 'files'
            ? `from local regression-test files (${localResolved.matchedFiles.length} match)`
            : 'no local TP SQL tables found';
      pushLog('info', 'TP SQL resolve service', `${localResolved.tables.length} table(s) ${sourceLabel}.`);
    } catch (error) {
      pushLog('warn', 'TP SQL resolve service failed', String(error));
    }

    if (authToken && activeProfile) {
      try {
        const configPayload = await readRegressionConfig(activeProfile, authToken);
        const beTables = preferredAssertionTables(extractTablesFromUnknownPayload(configPayload));
        if (beTables.length > 0) {
          merged = mergeCatalog(merged, beTables);
        }
        pushLog('info', 'TP SQL BE probe', `regressionConfig read completed (${beTables.length} table hint(s)).`);
      } catch (error) {
        pushLog('warn', 'TP SQL BE probe failed', String(error));
      }
    }

    return preferredAssertionTables(merged);
  }

  function updateImportText(value: string) {
    setImportText(value);
    setDockerLogLoaded(false);
    setAppliedDbCheckParams({});
  }

  async function importCurrentText() {
    if (!activeDraft) {
      pushLog('error', 'Import failed', 'No active template selected.');
      return;
    }
    if (!dockerLogLoaded) {
      pushLog('warn', 'Parse locked', 'Load runtime logs (docker or akeron.log) before parsing.');
      return;
    }

    const text = importText.trim();
    if (!text) {
      pushLog('warn', 'Import skipped', 'Paste TP SQL, dbCheck YAML, or WildFly log text first.');
      return;
    }

    if (selectedImportMode === 'Auto detect') {
      const sqlTables = await resolveTpSqlTablesForImport(text);
      const yamlTables = extractTablesFromYaml(text);
      const tables = mergeCatalog(sqlTables, yamlTables);
      const extracted = extractLaunchParamsFromRuntimeLog(text);
      const parsedParams = normalizeLaunchParams(extracted.params);
      const inferredTemplateType: TemplateType = yamlTables.length > sqlTables.length ? 'dbCheck YAML' : 'TP SQL';

      if (tables.length > 0) {
        addCatalogEntries(tables);
      }
      const sqlFixtureSource = activeDraft.launchParams['tpSql.sourceScript'] || sourceScriptPath.trim();
      const addedDraftTables = inferredTemplateType === 'TP SQL'
        ? applyImportedSqlFixturesToDraft(text, sqlFixtureSource) || applyImportedTablesToDraft(sqlTables)
        : 0;

      const sqlSummary = sqlTables.length > 0 ? extractLaunchSummaryFromSql(text) : {};
      updateDraft({
        templateText: text,
        templateType: inferredTemplateType,
        dbCheckConfig: inferredTemplateType === 'TP SQL' ? createBlankDbCheckConfig() : activeDraft.dbCheckConfig,
        launchParams: { ...activeDraft.launchParams, ...sqlSummary, ...parsedParams }
      });

      if (parsedParams.dbId && activeProfile) {
        updateProfile({ db: parsedParams.dbId });
      }

      const fromBlock = extracted.fromStampedBlock ? 'from STAMPA PARAMETRI block' : 'from generic lines';
      pushLog(
        'success',
        'Auto import completed',
        `${tables.length} catalog table(s), ${addedDraftTables} table draft(s), ${Object.keys(parsedParams).length} param(s) ${fromBlock}.`
      );
      tryMoveToStep('tables');
      return;
    }

    if (selectedImportMode === 'WildFly log') {
      const extracted = extractLaunchParamsFromRuntimeLog(text);
      const parsed = normalizeLaunchParams(extracted.params);
      if (Object.keys(parsed).length === 0) {
        pushLog('warn', 'WildFly log parsed', 'No launch params found. Paste lines after STAMPA PARAMETRI: INIZIO.');
        return;
      }
      updateDraft({ logText: text, launchParams: { ...activeDraft.launchParams, ...parsed } });
      if (parsed.dbId && activeProfile) updateProfile({ db: parsed.dbId });
      const fromBlock = extracted.fromStampedBlock ? 'from STAMPA PARAMETRI block' : 'from generic lines';
      pushLog('success', 'WildFly log parsed', `${Object.keys(parsed).length} launch params captured ${fromBlock}.`);
      tryMoveToStep('tables');
      return;
    }

    const tables = selectedImportMode === 'TP SQL'
      ? await resolveTpSqlTablesForImport(text)
      : extractTablesFromYaml(text);
    const parsedLaunchParams =
      selectedImportMode === 'TP SQL' ? normalizeLaunchParams(extractLaunchParamsFromRuntimeLog(text).params) : {};
    const sqlSummary = selectedImportMode === 'TP SQL' ? extractLaunchSummaryFromSql(text) : {};
    const sqlFixtureSource = activeDraft.launchParams['tpSql.sourceScript'] || sourceScriptPath.trim();
    const addedDraftTables = selectedImportMode === 'TP SQL'
      ? applyImportedSqlFixturesToDraft(text, sqlFixtureSource) || applyImportedTablesToDraft(tables)
      : 0;
    addCatalogEntries(tables);
    updateDraft({
      templateText: text,
      templateType: selectedImportMode,
      dbCheckConfig: selectedImportMode === 'TP SQL' ? createBlankDbCheckConfig() : activeDraft.dbCheckConfig,
      launchParams:
        selectedImportMode === 'TP SQL'
          ? { ...activeDraft.launchParams, ...sqlSummary, ...parsedLaunchParams }
          : activeDraft.launchParams
    });
    if (selectedImportMode === 'TP SQL' && parsedLaunchParams.dbId && activeProfile) {
      updateProfile({ db: parsedLaunchParams.dbId });
    }
    if (selectedImportMode === 'TP SQL') {
      if (tables.length === 0) {
        pushLog('warn', 'TP SQL parsed with no tables', 'No INSERT/SELECT INTO/DROP TABLE entries were detected. Check SQL format.');
      }
      pushLog(
        'success',
        'TP SQL imported',
        `${tables.length} catalog table(s), ${addedDraftTables} table draft(s), ${Object.keys(parsedLaunchParams).length} launch param(s) captured.`
      );
    } else {
      pushLog('success', `${selectedImportMode} imported`, `${tables.length} table(s) inferred.`);
    }
    tryMoveToStep('tables');
  }

  function importLaunchParamsOnly() {
    if (!activeDraft) {
      pushLog('error', 'Extraction failed', 'No active template selected.');
      return;
    }
    const text = importText.trim();
    if (!text) {
      pushLog('warn', 'Extraction skipped', 'Paste docker/wildfly log text first.');
      return;
    }

    applyRuntimeLogParams(text, 'pasted content');
  }

  function applyRuntimeLogParams(text: string, sourceLabel: string): boolean {
    if (!activeDraft) {
      pushLog('error', 'Launch params failed', 'No active template selected.');
      return false;
    }
    const extracted = extractLaunchParamsFromRuntimeLog(text);
    const parsed = normalizeLaunchParams(extracted.params);
    if (Object.keys(parsed).length === 0) {
      pushLog('warn', 'Launch params not found', 'Could not detect key=value lines in pasted content.');
      return false;
    }

    updateDraft({ logText: text, launchParams: { ...activeDraft.launchParams, ...parsed } });
    if (parsed.dbId && activeProfile) updateProfile({ db: parsed.dbId });
    const fromBlock = extracted.fromStampedBlock ? 'from STAMPA PARAMETRI block' : 'from generic lines';
    pushLog('success', 'Launch params extracted', `${Object.keys(parsed).length} parameter(s) captured ${fromBlock} (${sourceLabel}).`);
    return true;
  }

  function applyLoadedRuntimeLog(body: string, sourceKind: 'docker' | 'akeron-log', sourceRef: string) {
    setImportText(body);
    setDockerLogLoaded(true);
    if (templateTab === 'dynamic' || selectedImportMode === 'WildFly log') {
      setSelectedImportMode('WildFly log');
    }
    const lineCount = body ? body.split(/\r?\n/).length : 0;
    const sourceLabel = sourceKind === 'docker' ? `docker:${sourceRef}` : `akeron.log:${sourceRef}`;
    pushLog('success', 'Runtime log loaded', `${lineCount} line(s) copied from ${sourceLabel}.`);
    applyRuntimeLogParams(body, sourceLabel);
  }

  async function loadDockerLogs() {
    if (!activeDraft) {
      pushLog('error', 'Docker logs failed', 'No active template selected.');
      return;
    }
    const container = (activeProfile?.dockerContainer || '').trim();
    if (!container) {
      setDockerLogLoaded(false);
      pushLog('warn', 'Docker logs skipped', 'Set Docker container name first.');
      return;
    }

    const tail = Number.parseInt(activeProfile?.dockerTail || '1200', 10);
    const safeTail = Number.isFinite(tail) ? Math.max(1, Math.min(20000, tail)) : 1200;
    setDockerLoading(true);
    setDockerLogLoaded(false);
    pushLog('info', 'Docker logs', `Reading container ${container} (tail ${safeTail}).`);

    try {
      const response = await fetch(`/__docker/logs?container=${encodeURIComponent(container)}&tail=${encodeURIComponent(String(safeTail))}`);
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body || `HTTP ${response.status}`);
      }
      applyLoadedRuntimeLog(body, 'docker', container);
    } catch (error) {
      pushLog('error', 'Docker logs failed', String(error));
    } finally {
      setDockerLoading(false);
    }
  }

  async function loadAkeronLogFile() {
    if (!activeDraft) {
      pushLog('error', 'Akeron log failed', 'No active template selected.');
      return;
    }

    const logPath = (activeProfile?.akeronLogPath || '').trim();
    if (!logPath) {
      setDockerLogLoaded(false);
      pushLog('warn', 'Akeron log skipped', 'Set akeron.log path first.');
      return;
    }

    const tail = Number.parseInt(activeProfile?.dockerTail || '1200', 10);
    const safeTail = Number.isFinite(tail) ? Math.max(1, Math.min(20000, tail)) : 1200;
    setDockerLoading(true);
    setDockerLogLoaded(false);
    pushLog('info', 'Akeron log', `Reading ${logPath} (tail ${safeTail}).`);

    try {
      const body = await readLocalAkeronLog(logPath, safeTail);
      applyLoadedRuntimeLog(body, 'akeron-log', logPath);
    } catch (error) {
      pushLog('error', 'Akeron log failed', String(error));
    } finally {
      setDockerLoading(false);
    }
  }

  async function doAuth() {
    if (!activeProfile) return;
    setAuthBanner({ tone: 'loading', title: 'Authenticating', detail: baseUrl });
    pushLog('info', 'Auth start', `${activeProfile.username || '(empty user)'} @ ${baseUrl}`);
    try {
      const result = await authenticate(activeProfile);
      setAuthToken(result.token);
      setAuthBanner({ tone: 'success', title: 'Authenticated', detail: 'Bearer token received.' });
      pushLog('success', 'Auth done', 'Bearer token received from current BE.');
      tryMoveToStep('template');
    } catch (error) {
      setAuthToken('');
      setAuthBanner({ tone: 'error', title: 'Auth failed', detail: String(error) });
      pushLog('error', 'Auth failed', String(error));
    }
  }

  function stopRun() {
    cancelRunRef.current = true;
    setRunning(false);
    pushLog('warn', 'Run stopped', 'Current polling loop cancelled.');
  }

  async function runFlow(mode: 'direct' | 'scheduled') {
    if (!activeProfile) return;
    const effectiveMode: 'direct' | 'scheduled' = shouldUseDynamicFlow ? 'scheduled' : mode;
    if (effectiveMode !== mode) {
      pushLog('warn', 'Run mode adjusted', 'Dynamic DBCheck requires scheduled mode. Switching from direct to scheduled.');
    }
    cancelRunRef.current = false;
    clearRunResult();
    setRunning(true);
    pushLog('info', 'Run start', `${effectiveMode} flow against ${activeProfile.db}`);

    try {
      let token = authToken;
      if (!token) {
        const auth = await authenticate(activeProfile);
        token = auth.token;
        setAuthToken(auth.token);
        setAuthBanner({ tone: 'success', title: 'Authenticated', detail: 'Fresh token received before launch.' });
      }

      if (effectiveMode === 'scheduled') {
        let oid = '';
        let resultOid = '';
        if (shouldUseDynamicFlow) {
          const identity = buildDynamicIdentity(effectiveDbCheckConfig);
          resultOid = identity.oid;
          const dynamicPayload = buildDynamicLaunchParams(
            activeDraft?.launchParams ?? {},
            effectiveDbCheckConfig,
            activeProfile.db
          );
          const dynamicPayloadWithIdentity: Record<string, string> = {
            ...dynamicPayload,
            task: identity.task,
            TASK: identity.task,
            oid: identity.oid,
            OID: identity.oid,
            oidScheduler: identity.oid
          };
          pushLog(
            'info',
            'Dynamic payload',
            `task=${dynamicPayloadWithIdentity.task ?? '-'}, oid=${dynamicPayloadWithIdentity.oid ?? '-'}, e.codElab=${dynamicPayloadWithIdentity['e.codElab'] ?? '-'}, keys=${Object.keys(dynamicPayloadWithIdentity).length}`
          );
          const response = await upsertRegressionConfig(activeProfile, token, dynamicPayloadWithIdentity, identity.oid);
          oid = response.oidSchedule?.trim() ?? '';
          if (!oid) {
            throw new Error(`regressionConfig did not return oidSchedule: ${JSON.stringify(response)}`);
          }
          if (hasSelectedRegressionConfig(response, identity.oid)) {
            pushLog('success', 'Dynamic config accepted', `POST /regressionConfig returned configOid=${identity.oid}.`);
          } else {
            pushLog('warn', 'Dynamic config accepted without echo', 'POST /regressionConfig returned a schedule id but did not echo selectedConfig/configOid.');
          }
          try {
            const persistedConfig = await readRegressionConfig(activeProfile, token, identity.oid);
            if (hasSelectedRegressionConfig(persistedConfig, identity.oid)) {
              pushLog('success', 'Dynamic config visible', `GET /regressionConfig sees CONFIG_REGRTEST_ELAB oid=${identity.oid}.`);
            } else {
              pushLog(
                'warn',
                'Dynamic config not visible through GET',
                `Continuing because POST /regressionConfig returned schedule oid=${oid}. Verify dbo.CONFIG_REGRTEST_ELAB manually if TP does not execute DBCheck.`
              );
            }
          } catch (error) {
            pushLog(
              'warn',
              'Dynamic config visibility check failed',
              `Continuing after successful POST /regressionConfig. GET visibility error: ${String(error)}`
            );
          }
          pushLog('info', 'regressionConfig returned schedule oid', `statusOid=${oid}, resultOid=${resultOid}`);
        } else {
          oid = await runScheduled(activeProfile, token);
          resultOid = oid;
          pushLog('info', 'testRT returned oid', oid);
        }
        let status = '';
        while (!cancelRunRef.current) {
          status = await pollStatus(activeProfile, token, oid);
          pushLog('info', 'statusSched', status);
          if (!isPendingStatus(status)) break;
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
        if (cancelRunRef.current) return;
        const execDateCandidates = buildExecutionDateCandidates(activeDraft?.launchParams ?? {});
        pushLog('info', 'Execution date candidates', execDateCandidates.join(', '));

        let structuredResultRaw: string | null = null;
        let structuredStatus: string | null = null;
        const structuredErrors: string[] = [];
        for (const execDate of execDateCandidates) {
          try {
            const structuredResult = await getRegressionResult(activeProfile, token, resultOid || oid, execDate);
            structuredResultRaw = JSON.stringify(
              {
                dataEsecuzione: execDate,
                statusOid: oid,
                resultOid: resultOid || oid,
                ...structuredResult
              },
              null,
              2
            );
            structuredStatus = structuredResult.finalOutcome;
            pushLog('success', 'regressionResult resolved', `dataEsecuzione=${execDate}`);
            if (shouldUseDynamicFlow && structuredResult.dbCheckOutcome == null) {
              pushLog(
                'warn',
                'DBCheck snapshot missing',
                `Result resolved for ${resultOid || oid}, but dbCheckOutcome is null. TP did not persist a DBCheck snapshot for this OID/date.`
              );
            }
            break;
          } catch (error) {
            const detail = `dataEsecuzione=${execDate} -> ${String(error)}`;
            structuredErrors.push(detail);
            pushLog('warn', 'regressionResult failed', detail);
          }
        }

        if (structuredResultRaw && structuredStatus) {
          persistRun(effectiveMode, 'regressionResult', structuredStatus, structuredResultRaw);
          return;
        }

        let legacyResult: string | null = null;
        const legacyErrors: string[] = [];
        for (const execDate of execDateCandidates) {
          try {
            const result = await checkResult(activeProfile, token, resultOid || oid, execDate);
            legacyResult = `[dataEsecuzione=${execDate}] ${result}`;
            pushLog('success', 'checkResult resolved', `dataEsecuzione=${execDate}`);
            break;
          } catch (error) {
            const detail = `dataEsecuzione=${execDate} -> ${String(error)}`;
            legacyErrors.push(detail);
            pushLog('warn', 'checkResult failed', detail);
          }
        }

        if (legacyResult) {
          persistRun(effectiveMode, 'checkResult', legacyResult, legacyResult);
          return;
        }

        throw new Error(
          `No sched result found for statusOid=${oid}, resultOid=${resultOid || oid}. regressionResult errors: ${structuredErrors.join(' | ')}. checkResult errors: ${legacyErrors.join(' | ')}`
        );
      } else {
        const nameFile = await runDirect(activeProfile, token);
        pushLog('info', 'runRT returned semaphore', nameFile);
        let status = '';
        while (!cancelRunRef.current) {
          status = await verifyRun(activeProfile, token, nameFile);
          pushLog('info', 'verifyRT', status);
          if (!isPendingStatus(status)) break;
          await new Promise((resolve) => setTimeout(resolve, 10000));
        }
        if (cancelRunRef.current) return;
        persistRun(effectiveMode, 'verifyRT', status);
      }
    } catch (error) {
      pushLog('error', 'Run failed', String(error));
    } finally {
      if (!cancelRunRef.current) setRunning(false);
    }
  }

  function persistRun(mode: 'direct' | 'scheduled', phase: string, status: string, raw = status) {
    pushLog(isSuccessStatus(status) ? 'success' : 'error', 'Run complete', status);
    setState((current) => ({
      ...current,
      resultHistory: [{ id: uid('run'), at: new Date().toISOString(), mode, phase, status, raw }, ...current.resultHistory]
    }));
  }

  function clearRunResult() {
    setState((current) => ({
      ...current,
      resultHistory: []
    }));
  }

  async function copyBundle() {
    if (!activeProfile || !activeDraft) return;
    await copyText(buildPromptBundle(activeProfile, activeDraft));
    pushLog('success', 'Prompt bundle copied', 'Ready for Codex CLI / IDE handoff.');
  }

  function downloadBundleJson() {
    if (!activeProfile || !activeDraft) return;
    downloadText('dbcheck-composer-bundle.json', buildDraftJson(activeProfile, activeDraft));
    pushLog('success', 'Bundle downloaded', 'JSON snapshot saved locally.');
  }

  function downloadBundlePrompt() {
    if (!activeProfile || !activeDraft) return;
    downloadText('dbcheck-composer-bundle.md', buildPromptBundle(activeProfile, activeDraft));
    pushLog('success', 'Prompt downloaded', 'Markdown bundle saved locally.');
  }

  function goNext() {
    const next = steps[Math.min(stepIndex(activeStep) + 1, steps.length - 1)];
    tryMoveToStep(next.id);
  }

  function goBack() {
    const previous = steps[Math.max(stepIndex(activeStep) - 1, 0)];
    setActiveStep(previous.id);
  }

  return (
    <div className="app-shell">
      <aside className="wizard-rail">
        <div className="brand-block">
          <Database size={24} aria-hidden="true" />
          <div>
            <strong>DbCheck Composer</strong>
            <span>{activeProfile?.db || 'No dbId'}</span>
          </div>
        </div>

        <nav className="steps" aria-label="Wizard steps">
          {steps.map(({ id, label, detail, Icon }) => (
            <button
              className={`step-button ${activeStep === id ? 'active' : ''} ${stepErrors[id] ? 'invalid' : ''}`}
              key={id}
              onClick={() => tryMoveToStep(id)}
              disabled={!canAccessStep(id)}
              type="button"
            >
              <span className={`step-icon ${completed[id] ? 'done' : ''} ${!completed[id] && stepErrors[id] ? 'invalid' : ''}`}>
                {completed[id] ? <CheckCircle2 size={18} aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}
              </span>
              <span className="step-copy">
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className={`rail-status ${authBanner.tone}`} aria-live="polite">
          <strong>{authBanner.title}</strong>
          <span>{authBanner.detail}</span>
        </div>
      </aside>

      <main className="wizard-main">
        {toast && (
          <div className={`toast-banner ${toast.tone}`} role="status" aria-live="polite">
            {toast.message}
          </div>
        )}
        <header className="wizard-header">
          <div>
            <p>Step {stepIndex(activeStep) + 1} of {steps.length}</p>
            <h1>{currentStep.label}</h1>
          </div>
          <div className="header-actions">
            <button className="secondary" onClick={addDraft} type="button"><Plus size={16} /> New template</button>
            <button className="secondary" onClick={resetWorkspace} type="button"><RotateCcw size={16} /> Reset</button>
          </div>
        </header>

        {activeStep === 'connect' && (
          <section className="wizard-panel">
            <SectionHeader title="Connection profile" meta={baseUrl || 'Missing host'} />
            <div className="form-grid">
              <Field label="Profile">
                <select value={state.activeProfileId} onChange={(event) => setState((current) => ({ ...current, activeProfileId: event.target.value }))}>
                  {state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </Field>
              <Field label="Profile name"><input value={activeProfile?.name ?? ''} onChange={(event) => updateProfile({ name: event.target.value })} /></Field>
              <Field label="Host"><input value={activeProfile?.host ?? ''} onChange={(event) => updateProfile({ host: event.target.value })} /></Field>
              <Field label="Port"><input value={activeProfile?.port ?? ''} onChange={(event) => updateProfile({ port: event.target.value })} /></Field>
              <Field label="ctxRoot"><input value={activeProfile?.ctxRoot ?? ''} onChange={(event) => updateProfile({ ctxRoot: event.target.value })} /></Field>
              <Field label="dbId"><input value={activeProfile?.db ?? ''} onChange={(event) => updateProfile({ db: event.target.value })} /></Field>
              <Field label="Username"><input autoComplete="username" value={activeProfile?.username ?? ''} onChange={(event) => updateProfile({ username: event.target.value })} /></Field>
              <Field label="Password"><input autoComplete="current-password" type="password" value={activeProfile?.password ?? ''} onChange={(event) => updateProfile({ password: event.target.value })} /></Field>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={activeProfile?.remember ?? true} onChange={(event) => updateProfile({ remember: event.target.checked })} />
              Remember profile locally
            </label>
            <div className={`inline-status ${authBanner.tone}`} aria-live="polite">
              <strong>{authBanner.title}</strong>
              <span>{authBanner.detail}</span>
            </div>
            <div className="button-row">
              <button onClick={doAuth} disabled={!hasProfile || authBanner.tone === 'loading'} type="button">
                {authBanner.tone === 'loading' ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
                Authenticate
              </button>
              <button className="secondary" onClick={addProfile} type="button"><Plus size={16} /> Add profile</button>
            </div>
          </section>
        )}

        {activeStep === 'template' && (
          <section className="wizard-panel">
            <SectionHeader title="Template step" meta={templateTab === 'dynamic' ? 'Dynamic DBCheck selected' : 'Template Import selected'} />
            <div className="template-step-actions">
              <button className="secondary" onClick={() => setTemplateGuideOpen(true)} type="button">
                <Clipboard size={16} /> Guide
              </button>
              <button className="secondary" onClick={resetTemplateStep} type="button">
                <RotateCcw size={16} /> Reset template step
              </button>
            </div>
            <div className="template-block-title">
              <strong>Common template config</strong>
              <span>Shared by Template Import and Dynamic DBCheck.</span>
            </div>
            <div className="template-common-card">
              <div className="template-common-index">01</div>
              <div className="template-common-layout">
                <div className="template-selector-row">
                  <Field label="Template">
                    <select value={state.activeDraftId} onChange={(event) => setState((current) => ({ ...current, activeDraftId: event.target.value }))}>
                      {state.drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.name}</option>)}
                    </select>
                  </Field>
                  <div className="template-inline-actions">
                    <button className="secondary" onClick={addDraft} type="button"><Plus size={16} /> New</button>
                    <button className="secondary" onClick={duplicateActiveDraft} type="button"><Copy size={16} /> Duplicate</button>
                    <button className="secondary danger-outline" onClick={removeActiveDraft} type="button"><Trash2 size={16} /> Remove</button>
                  </div>
                </div>
                <div className="template-common-fields">
                  <Field label="Template name">
                    <input placeholder="Short name for this template" value={activeDraft?.name ?? ''} onChange={(event) => updateDraft({ name: event.target.value })} />
                    <small className="field-help">Use this name to manage multiple templates in DbCheck Composer.</small>
                  </Field>
                  <Field label="Launch mode">
                    <select value={activeDraft?.launchMode ?? 'direct'} onChange={(event) => updateDraft({ launchMode: event.target.value as 'direct' | 'scheduled' })}>
                      <option value="direct">Direct</option>
                      <option value="scheduled">Scheduled</option>
                    </select>
                    <small className="field-help">Dynamic DBCheck uses scheduled mode because params are posted to regressionConfig.</small>
                  </Field>
                </div>
                <div className="template-counter">
                  <strong>{state.drafts.length}</strong>
                  <span>template(s)</span>
                </div>
              </div>
            </div>
            <div className="template-block-title">
              <strong>Choose creation path</strong>
              <span>Import existing TP assets or compose the new generic DBCheck contract.</span>
            </div>
            <div className="template-tabs template-mode-cards" role="tablist" aria-label="Template mode">
              <button className={`tab-button template-mode-card import ${templateTab === 'import' ? 'active' : ''}`} onClick={() => setTemplateTab('import')} role="tab" aria-selected={templateTab === 'import'} type="button">
                <span className="mode-check" aria-hidden="true" />
                <span>Template Import</span>
                <strong>Docker log / TP SQL / YAML</strong>
                <small>{dockerLogLoaded ? 'Docker log loaded' : 'Parse waits for docker log'}</small>
              </button>
              <button className={`tab-button template-mode-card dynamic ${templateTab === 'dynamic' ? 'active' : ''}`} onClick={() => setTemplateTab('dynamic')} role="tab" aria-selected={templateTab === 'dynamic'} type="button">
                <span className="mode-check" aria-hidden="true" />
                <span>Dynamic DBCheck</span>
                <strong>Generic config, no Java hardcode</strong>
                <small>{dbCheckMissing.length ? `Missing ${dbCheckMissing.length} field(s)` : 'Contract complete'}</small>
              </button>
            </div>
 
            {templateTab === 'import' && (
              <div className="tab-panel">
                <div className="form-grid compact">
                <Field label="Source type">
                  <select value={selectedImportMode} onChange={(event) => setSelectedImportMode(event.target.value as 'Auto detect' | 'TP SQL' | 'dbCheck YAML' | 'WildFly log')}>
                    <option value="Auto detect">Auto detect</option>
                    <option value="TP SQL">TP SQL</option>
                    <option value="dbCheck YAML">dbCheck YAML</option>
                    <option value="WildFly log">WildFly log</option>
                  </select>
                  <small className="field-help">Auto detect extracts tables and launch params from pasted or docker-loaded text.</small>
                </Field>
                  <div className={`load-state ${dockerLogLoaded ? 'success' : 'idle'}`}>
                    <strong>{dockerLogLoaded ? 'Runtime log ready' : 'Runtime log required'}</strong>
                    <span>{dockerLogLoaded ? 'Parse and continue is enabled.' : 'Parse and continue is disabled until a runtime log load succeeds.'}</span>
                  </div>
                </div>
                <Field label="Paste template or log">
                  <textarea
                    rows={14}
                    placeholder={'Paste TP SQL, dbCheck YAML, or WildFly STAMPA PARAMETRI log here.\nRecommended: load docker logs first, then parse.'}
                    value={importText}
                    onChange={(event) => updateImportText(event.target.value)}
                  />
                  <small className="field-help">Parse is intentionally locked until runtime logs are loaded (docker or akeron.log), to avoid stale manual input.</small>
                </Field>
                <div className="runtime-log-panel">
                  <Field label="Akeron log path" className="log-path-field">
                    <input
                      placeholder="C:\\sviluppo\\wildfly-java\\log\\vulki\\akeron.log"
                      value={activeProfile?.akeronLogPath ?? ''}
                      onChange={(event) => updateProfile({ akeronLogPath: event.target.value })}
                    />
                    <small className="field-help">Use local akeron.log for CALCOLO_PREMI parameters.</small>
                  </Field>
                  <Field label="Docker container">
                    <input
                      placeholder="regtest-container"
                      value={activeProfile?.dockerContainer ?? ''}
                      onChange={(event) => updateProfile({ dockerContainer: event.target.value })}
                    />
                    <small className="field-help">Container that writes WildFly regression logs.</small>
                  </Field>
                  <Field label="Tail lines">
                    <input
                      inputMode="numeric"
                      placeholder="1200"
                      value={activeProfile?.dockerTail ?? '1200'}
                      onChange={(event) => updateProfile({ dockerTail: event.target.value })}
                    />
                    <small className="field-help">How many recent log lines to import.</small>
                  </Field>
                  <button onClick={loadAkeronLogFile} disabled={dockerLoading} type="button">
                    {dockerLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Load akeron.log
                  </button>
                  <button className="secondary" onClick={loadDockerLogs} disabled={dockerLoading} type="button">
                    {dockerLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Load docker logs
                  </button>
                </div>
                <div className="source-script-panel">
                  <Field label="TP SQL source script">
                    <input
                      placeholder="C:\\sviluppo\\devgit\\regression-test\\scriptSql\\ic_01\\DONE\\CAL_PREMI_STEP_FORMULA_TP_8668_001.sql"
                      value={sourceScriptPath}
                      onChange={(event) => setSourceScriptPath(event.target.value)}
                    />
                    <small className="field-help">Use this to hydrate Tables from oracle inserts when runtime params come from akeron.log.</small>
                  </Field>
                  <button onClick={loadTpSqlSourceScript} disabled={sourceScriptLoading} type="button">
                    {sourceScriptLoading ? <Loader2 className="spin" size={16} /> : <FileInput size={16} />}
                    Load source script
                  </button>
                </div>
                <div className="tab-actions import-actions">
                  <button className="secondary" onClick={importLaunchParamsOnly} type="button"><FileInput size={16} /> Extract params only</button>
                  <button onClick={importCurrentText} disabled={!dockerLogLoaded || dockerLoading} type="button"><FileInput size={16} /> Parse and continue</button>
                </div>
              </div>
            )}

            {templateTab === 'dynamic' && (
              <div className="tab-panel dbcheck-config-panel">
                <div className="dynamic-hero">
                  <div>
                    <strong>Dynamic DBCheck contract</strong>
                    <span>{dynamicPreflightErrors.length ? `Missing: ${dynamicPreflightErrors.join(', ')}` : 'Contract complete and artifacts resolved'}</span>
                  </div>
                  <span className={`state-pill ${dynamicPreflightErrors.length ? 'warn' : 'success'}`}>{dynamicPreflightErrors.length ? 'Fix required' : 'Ready'}</span>
                </div>
                <div className="template-block-title compact">
                  <strong>Load launch params from runtime log</strong>
                  <span>{dockerLogLoaded ? 'Runtime log loaded and params applied.' : 'Use docker logs or akeron.log to import STAMPA PARAMETRI in Dynamic mode.'}</span>
                </div>
                <div className="runtime-log-panel">
                  <Field label="Akeron log path" className="log-path-field">
                    <input
                      placeholder="C:\\sviluppo\\wildfly-java\\log\\vulki\\akeron.log"
                      value={activeProfile?.akeronLogPath ?? ''}
                      onChange={(event) => updateProfile({ akeronLogPath: event.target.value })}
                    />
                    <small className="field-help">Preferred source for CALCOLO_PREMI params.</small>
                  </Field>
                  <Field label="Docker container">
                    <input
                      placeholder="regtest-container"
                      value={activeProfile?.dockerContainer ?? ''}
                      onChange={(event) => updateProfile({ dockerContainer: event.target.value })}
                    />
                    <small className="field-help">Container that writes WildFly regression logs.</small>
                  </Field>
                  <Field label="Tail lines">
                    <input
                      inputMode="numeric"
                      placeholder="1200"
                      value={activeProfile?.dockerTail ?? '1200'}
                      onChange={(event) => updateProfile({ dockerTail: event.target.value })}
                    />
                    <small className="field-help">How many recent log lines to read.</small>
                  </Field>
                  <button onClick={loadAkeronLogFile} disabled={dockerLoading} type="button">
                    {dockerLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Load akeron.log
                  </button>
                  <button className="secondary" onClick={loadDockerLogs} disabled={dockerLoading} type="button">
                    {dockerLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Load docker logs
                  </button>
                </div>
                <div className="tab-actions">
                  <button className="secondary" onClick={importLaunchParamsOnly} disabled={!importText.trim() || dockerLoading} type="button">
                    <FileInput size={16} /> Extract launch params
                  </button>
                </div>
              <div className="form-grid compact">
                <Field label="Persisted task fallback">
                  <input placeholder="REGR_TEST" value={dbCheckConfig.taskCode} onChange={(event) => updateDbCheckConfig({ taskCode: event.target.value })} />
                  <small className="field-help">Fallback task code used when e.codElab is empty.</small>
                </Field>
                <Field label="e.codElab">
                  <input placeholder="SCORECARD_DBCHECK" value={dbCheckConfig.codElab} onChange={(event) => updateDbCheckConfig({ codElab: event.target.value })} />
                  <small className="field-help">Dynamic elaboration code used by TP to choose the configured DBCheck recipe.</small>
                </Field>
                <Field label="dbcheck.catalogResources">
                  <input
                    placeholder="generated-applicativo/scorecard.yaml, generated-applicativo/payee.yaml"
                    value={dbCheckConfig.catalogResources}
                    onChange={(event) => updateDbCheckConfig({ catalogResources: event.target.value })}
                  />
                  <small className="field-help">Comma-separated catalog YAML resources. Prefer autocomplete below.</small>
                </Field>
                <Field label="dbcheck.regressionResource">
                  <input
                    list="dbcheck-regression-resource-options"
                    placeholder="scorecard/scorecard-regression.yaml"
                    value={dbCheckConfig.regressionResource}
                    onChange={(event) => updateDbCheckConfig({ regressionResource: event.target.value })}
                  />
                  <small className="field-help">Regression YAML under TP DBCheck regression-test resources.</small>
                  <datalist id="dbcheck-regression-resource-options">
                    {regressionResources.map((resource) => (
                      <option key={resource.resource} value={resource.resource}>{resource.label}</option>
                    ))}
                  </datalist>
                </Field>
              </div>
              <div className="catalog-resource-panel">
                <div className="template-block-title compact">
                  <strong>TP catalog resources</strong>
                  <span>
                    {catalogResources.length
                      ? `${catalogResources.length} resource(s) available (${catalogSource === 'backend' ? 'backend' : catalogSource === 'local' ? 'local fallback' : 'not loaded'})`
                      : 'Load from TP backend for autocomplete.'}
                  </span>
                </div>
                <div className="table-autocomplete-row">
                  <div className="field table-name-field">
                    <span>Catalog resource</span>
                    <label className="autocomplete-field">
                      <Search size={16} aria-hidden="true" />
                      <input
                        list="dbcheck-catalog-resource-options"
                        placeholder="generated-applicativo/articoli.yaml"
                        value={catalogResourceInput}
                        onChange={(event) => setCatalogResourceInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            appendCatalogResource();
                          }
                        }}
                      />
                    </label>
                    <datalist id="dbcheck-catalog-resource-options">
                      {catalogResources.map((resource) => (
                        <option key={resource.resource} value={resource.resource}>{resource.label}</option>
                      ))}
                    </datalist>
                  </div>
                  <button className="secondary" onClick={() => loadDbCheckCatalogResources(true)} disabled={catalogLoading || !authToken} type="button">
                    {catalogLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                    Load catalog
                  </button>
                  <button onClick={appendCatalogResource} type="button"><Plus size={16} /> Add resource</button>
                </div>
              </div>
              <div className="dbcheck-param-grid">
                <Field label="dbcheck.runtime.*">
                  <textarea
                    rows={5}
                    placeholder={'contractId=CONTRACT_1\npayeeIds=PAYEE_1,PAYEE_2'}
                    value={dbCheckConfig.runtimeText}
                    onChange={(event) => updateDbCheckConfig({ runtimeText: event.target.value })}
                  />
                  <small className="field-help">Runtime inputs. Each line becomes dbcheck.runtime.&lt;key&gt;.</small>
                </Field>
                <Field label="dbcheck.expected.*">
                  <textarea
                    rows={5}
                    placeholder={'expectedRows=2\nexpectedAmount=12.50'}
                    value={dbCheckConfig.expectedText}
                    onChange={(event) => updateDbCheckConfig({ expectedText: event.target.value })}
                  />
                  <small className="field-help">Expected assertions. Each line becomes dbcheck.expected.&lt;key&gt;.</small>
                </Field>
              </div>
                <div className="applied-output">
                  <div className="template-block-title compact">
                    <strong>Output after Apply DBCheck Config</strong>
                    <span>{Object.keys(appliedDbCheckParams).length ? `${Object.keys(appliedDbCheckParams).length} generated parameter(s)` : 'Nothing applied yet.'}</span>
                  </div>
                  <DbCheckParamCards params={appliedDbCheckParams} rawText={dbCheckParametri} />
                </div>
                <div className={`preflight-panel ${dynamicPreflightErrors.length ? 'error' : 'success'}`}>
                  <div className="template-block-title compact">
                    <strong>Dynamic preflight</strong>
                    <span>
                      {dynamicPreflightErrors.length
                        ? `${dynamicPreflightErrors.length} issue(s)`
                        : dynamicPreflightWarnings.length
                          ? 'Ready with warnings'
                          : 'All checks passed'}
                    </span>
                  </div>
                  {dynamicPreflightErrors.length > 0 ? (
                    <ul className="preflight-list">
                      {dynamicPreflightErrors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">Catalog resources and regression YAML are aligned with this config.</p>
                  )}
                  {dynamicPreflightWarnings.length > 0 && (
                    <ul className="preflight-warning-list">
                      {dynamicPreflightWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              <div className="tab-actions dynamic-actions">
                <button className="secondary" onClick={applyScorecardSample} type="button"><Clipboard size={16} /> SCORECARD sample</button>
                <button className="secondary" onClick={() => loadRegressionResources(true)} disabled={regressionLoading} type="button">
                  {regressionLoading ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  Load regression YAML
                </button>
                <button className="secondary" onClick={copyMissingArtifactsPrompt} disabled={!dynamicPreflightErrors.length} type="button">
                  <Clipboard size={16} /> Generate BE prompt
                </button>
                <button onClick={() => applyDbCheckConfig()} type="button"><Settings2 size={16} /> Apply DBCheck config</button>
              </div>
              </div>
            )}
            <LaunchParamChips params={activeDraft?.launchParams ?? {}} />
          </section>
        )}

        {activeStep === 'tables' && (
          <section className="wizard-panel tables-panel">
            <SectionHeader
              title={isDynamicDbCheck ? 'Dynamic DBCheck resources' : 'Tables and assert rows'}
              meta={isDynamicDbCheck ? `${dynamicPreflightErrors.length ? 'Incomplete' : 'Ready'} contract` : `${draftTables.length} table(s) selected`}
            />
            {isDynamicDbCheck ? (
              <DynamicDbCheckTables config={dbCheckConfig} params={dbCheckLaunchParams} missing={dynamicPreflightErrors} />
            ) : (
              <div className="tables-simple">
                {(activeDraft?.launchParams['tpSql.sourceScript'] || draftTables.some((table) => table.sourceRef)) && (
                  <div className="source-script-summary">
                    <span>TP SQL source</span>
                    <strong>{activeDraft?.launchParams['tpSql.sourceScript'] || selectedTable?.sourceRef || 'Imported template'}</strong>
                    <small>{draftTables.reduce((sum, table) => sum + table.rows.length, 0)} assert row(s) across {draftTables.length} selected table(s).</small>
                  </div>
                )}
                <div className="table-autocomplete-row">
                  <div className="field table-name-field">
                    <span>Table</span>
                    <label className="autocomplete-field">
                      <Search size={16} aria-hidden="true" />
                      <input
                        list="table-catalog-options"
                        placeholder="Start typing table name"
                        value={tableNameInput}
                        onChange={(event) => setTableNameInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addTableFromInput();
                          }
                        }}
                      />
                    </label>
                    <datalist id="table-catalog-options">
                      {state.catalog.map((table) => <option key={table} value={table} />)}
                    </datalist>
                  </div>
                  <button onClick={addTableFromInput} type="button"><Plus size={16} /> Add table</button>
                  <button className="secondary" onClick={() => addDraftTableAndSelect()} type="button"><Plus size={16} /> Blank</button>
                  <button className="icon-button" onClick={() => addCatalogEntries(['CONTRATTO', 'CONTRATTO_CONF_ORACOLO'])} aria-label="Add sample tables" title="Add sample tables" type="button">
                    <Plus size={16} />
                  </button>
                </div>

                <div className="selected-table-strip" aria-label="Selected tables">
                  {draftTables.length ? draftTables.map((table) => (
                    <button
                      className={`table-pill ${selectedTable?.id === table.id ? 'active' : ''}`}
                      key={table.id}
                      onClick={() => setSelectedTableId(table.id)}
                      type="button"
                    >
                      <Table2 size={16} aria-hidden="true" />
                      <span>{table.name || 'Unnamed table'}</span>
                    </button>
                  )) : <span className="muted">No table selected.</span>}
                </div>

                <div className="table-editor-pane" aria-label="Assert editor">
                  {selectedTable ? (
                    <TableEditor
                      table={selectedTable}
                      onChange={(next) => updateActiveDraft((draft) => updateDraftTable(draft, selectedTable.id, () => next))}
                      onRemove={() => removeDraftTable(selectedTable.id)}
                    />
                  ) : (
                    <div className="empty-editor">
                      <Table2 size={24} aria-hidden="true" />
                      <strong>No table selected</strong>
                      <span>Add a table from catalog or create one manually.</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {activeStep === 'run' && (
          <section className="wizard-panel">
            <SectionHeader title="Run and export" meta={lastRun ? `${lastRun.phase}: ${lastRun.status}` : 'No run yet'} />
            <div className="summary-grid">
              <Summary label="Connection" value={authToken ? 'Authenticated' : 'Missing token'} tone={authToken ? 'success' : 'warn'} />
              <Summary label="Template" value={hasTemplate ? 'Ready' : 'Empty'} tone={hasTemplate ? 'success' : 'warn'} />
              <Summary label="Tables" value={shouldUseDynamicFlow ? 'Dynamic DBCheck' : `${draftTables.length} selected`} tone={hasTables ? 'success' : 'warn'} />
              <Summary
                label="Preflight"
                value={shouldUseDynamicFlow ? (dynamicPreflightErrors.length ? 'Missing YAML/config' : 'Ready') : 'N/A'}
                tone={shouldUseDynamicFlow && dynamicPreflightErrors.length ? 'warn' : 'success'}
              />
              <Summary label="Launch mode" value={shouldUseDynamicFlow ? 'Scheduled (forced for Dynamic DBCheck)' : activeDraft?.launchMode === 'scheduled' ? 'Scheduled' : 'Direct'} tone="success" />
            </div>
            <div className="button-row">
              <button onClick={() => runFlow(activeDraft?.launchMode ?? 'direct')} disabled={running || (shouldUseDynamicFlow && dynamicPreflightErrors.length > 0)} type="button">
                <Play size={16} /> {shouldUseDynamicFlow || activeDraft?.launchMode === 'scheduled' ? 'Start schedule' : 'Start direct'}
              </button>
              <button className="danger" onClick={stopRun} disabled={!running} type="button"><Square size={16} /> Stop</button>
              <button className="secondary" onClick={copyBundle} type="button"><Clipboard size={16} /> Copy prompt</button>
              <button className="secondary" onClick={downloadBundleJson} type="button"><Download size={16} /> JSON</button>
              <button className="secondary" onClick={downloadBundlePrompt} type="button"><Download size={16} /> Prompt</button>
            </div>
            <RunResult lastRun={lastRun} running={running} logs={logs} />
          </section>
        )}

        {templateGuideOpen && <TemplateGuideModal onClose={() => setTemplateGuideOpen(false)} />}

        <footer className="wizard-footer">
          <button className="secondary" onClick={goBack} disabled={activeStep === 'connect'} type="button">Back</button>
          {activeStep !== 'run' && (
            <button onClick={goNext} disabled={!canAccessStep(steps[Math.min(stepIndex(activeStep) + 1, steps.length - 1)].id)} type="button">Next</button>
          )}
        </footer>
      </main>
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`field ${className}`.trim()}><span>{label}</span>{children}</label>;
}

function SectionHeader({ title, meta }: { title: string; meta: string }) {
  return <div className="section-head"><h2>{title}</h2><span>{meta}</span></div>;
}

function TemplateGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="guide-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="guide-dialog" role="dialog" aria-modal="true" aria-labelledby="template-guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="guide-head">
          <div>
            <span>Template step guide</span>
            <h2 id="template-guide-title">Configure the regression input</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close template guide" type="button">X</button>
        </div>
        <div className="guide-grid">
          <article>
            <strong>Choose path</strong>
            <p>Use Template Import when you already have TP SQL, YAML, or WildFly logs. Use Dynamic DBCheck for the new generic flow without Java hardcode.</p>
          </article>
          <article>
            <strong>Dynamic fields</strong>
            <p>`e.codElab` selects the TP elaboration. Catalog resources define datasets. Regression resource points to the YAML checks. Runtime and expected blocks become launch params.</p>
          </article>
          <article>
            <strong>Apply config</strong>
            <p>Click Apply DBCheck config before Run. The UI generates `dbcheck.*` params and scheduled run posts them to AKN `regressionConfig`.</p>
          </article>
          <article>
            <strong>Reset safely</strong>
            <p>Reset template step clears only the current draft template/import/dynamic config. It keeps connection profile, tables, and run history.</p>
          </article>
        </div>
        <div className="guide-flow">
          <span>Recommended flow</span>
          <code>Authenticate → Dynamic DBCheck → Load catalog → Add resources → Set regression YAML → Add runtime/expected → Apply → Run</code>
        </div>
      </section>
    </div>
  );
}

function ChipList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return <div className="chip-list">{items.map((item) => <span className="chip" key={item}>{item}</span>)}</div>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone: 'success' | 'warn' }) {
  return <div className={`summary ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

type DbCheckParamTone = 'core' | 'catalog' | 'runtime' | 'expected';

function dbCheckParamTone(key: string): DbCheckParamTone {
  if (key === 'dbcheck.catalogResources' || key === 'dbcheck.regressionResource') return 'catalog';
  if (key.startsWith('dbcheck.runtime.')) return 'runtime';
  if (key.startsWith('dbcheck.expected.')) return 'expected';
  return 'core';
}

function dbCheckParamTitle(key: string): string {
  if (key === 'e.codElab') return 'Elaboration';
  if (key === 'dbcheck.catalogResources') return 'Catalog resources';
  if (key === 'dbcheck.regressionResource') return 'Regression YAML';
  if (key.startsWith('dbcheck.runtime.')) return 'Runtime input';
  if (key.startsWith('dbcheck.expected.')) return 'Expected assert';
  return 'Core parameter';
}

function DbCheckParamCards({ params, rawText }: { params: Record<string, string>; rawText: string }) {
  const entries = Object.entries(params);
  const [selectedParam, setSelectedParam] = useState<{ key: string; value: string } | null>(null);

  if (entries.length === 0) {
    return <div className="param-card empty"><strong>No DBCheck params generated</strong><span>{rawText || 'Fill Dynamic DBCheck fields.'}</span></div>;
  }

  return (
    <>
      <div className="param-chip-list" aria-label="Generated DBCheck params">
        {entries.map(([key, value]) => (
          <button
            className={`param-chip ${dbCheckParamTone(key)}`}
            data-detail={`${key} = ${value}`}
            key={key}
            onClick={() => setSelectedParam({ key, value })}
            title={`${key}\n${value}`}
            type="button"
          >
            <span>{dbCheckParamTitle(key)}</span>
            <strong>{key.replace('dbcheck.', '')}</strong>
          </button>
        ))}
      </div>
      {selectedParam && (
        <div className="param-popover-backdrop" onClick={() => setSelectedParam(null)} role="presentation">
          <section className={`param-popover ${dbCheckParamTone(selectedParam.key)}`} role="dialog" aria-modal="true" aria-label="DBCheck parameter detail" onClick={(event) => event.stopPropagation()}>
            <div className="param-popover-head">
              <div>
                <span>{dbCheckParamTitle(selectedParam.key)}</span>
                <strong>{selectedParam.key}</strong>
              </div>
              <button className="icon-button" onClick={() => setSelectedParam(null)} aria-label="Close parameter detail" type="button">X</button>
            </div>
            <code>{selectedParam.value}</code>
          </section>
        </div>
      )}
    </>
  );
}

function LaunchParamChips({ params }: { params: Record<string, string> }) {
  const entries = Object.entries(params).slice(0, 16);
  if (entries.length === 0) return <p className="muted">No launch params parsed yet.</p>;

  return (
    <div className="launch-param-area">
      <div className="template-block-title compact">
        <strong>Launch params</strong>
        <span>{Object.keys(params).length} parsed parameter(s)</span>
      </div>
      <div className="param-chip-list" aria-label="Parsed launch params">
        {entries.map(([key, value]) => (
          <span className={`param-chip readonly ${dbCheckParamTone(key)}`} data-detail={`${key} = ${value}`} key={key} title={`${key}\n${value}`}>
            <span>{dbCheckParamTitle(key)}</span>
            <strong>{key}: {value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function splitCatalogResources(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function DynamicDbCheckTables({ config, params, missing }: { config: DbCheckConfig; params: Record<string, string>; missing: string[] }) {
  const catalogResources = splitCatalogResources(config.catalogResources);
  const runtimeParams = Object.entries(params).filter(([key]) => key.startsWith('dbcheck.runtime.'));
  const expectedParams = Object.entries(params).filter(([key]) => key.startsWith('dbcheck.expected.'));

  return (
    <div className="dynamic-table-alignment">
      <div className="dynamic-resource-card catalog">
        <span>Catalog resources</span>
        <div className="resource-chip-list">
          {catalogResources.length ? catalogResources.map((resource) => <code className="resource-chip" key={resource}>{resource}</code>) : <strong>Missing catalog</strong>}
        </div>
      </div>
      <div className="dynamic-resource-card regression">
        <span>Regression resource</span>
        <strong>{config.regressionResource || 'Missing regression YAML'}</strong>
      </div>
      <div className="dynamic-resource-card runtime">
        <span>Runtime params</span>
        <strong>{runtimeParams.length} field(s)</strong>
        <ChipList items={runtimeParams.map(([key, value]) => `${key.replace('dbcheck.runtime.', '')}: ${value}`)} empty="No runtime params." />
      </div>
      <div className="dynamic-resource-card expected">
        <span>Expected asserts</span>
        <strong>{expectedParams.length} field(s)</strong>
        <ChipList items={expectedParams.map(([key, value]) => `${key.replace('dbcheck.expected.', '')}: ${value}`)} empty="No expected params." />
      </div>
      <div className={`dynamic-contract-state ${missing.length ? 'warn' : 'success'}`}>
        <strong>{missing.length ? 'Contract incomplete' : 'Contract ready'}</strong>
        <span>{missing.length ? missing.join(', ') : 'Tables are provided by DBCheck catalog resources.'}</span>
      </div>
    </div>
  );
}

function RunResult({ lastRun, running, logs }: { lastRun: WorkspaceState['resultHistory'][number] | undefined; running: boolean; logs: LogEntry[] }) {
  const resultText = lastRun ? lastRun.raw : running ? 'Run started. Waiting for schedule/result...' : 'No result yet.';
  return (
    <div className="run-grid">
      <div className="result-panel">
        <span className={`state-pill ${running ? 'loading' : lastRun ? 'success' : 'idle'}`}>{running ? 'Running' : lastRun ? lastRun.status : 'Idle'}</span>
        <pre>{resultText}</pre>
      </div>
      <div className="activity-panel">
        {logs.slice(0, 8).map((log) => (
          <div className={`activity ${log.level}`} key={log.id}>
            <strong>{log.title}</strong>
            <span>{log.detail || new Date(log.at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableEditor({ table, onChange, onRemove }: { table: TableDraft; onChange: (table: TableDraft) => void; onRemove: () => void }) {
  const columns = table.columns;

  function updateColumns(nextColumns: string[]) {
    const normalized = nextColumns.filter((column) => column.trim().length > 0);
    const rows = table.rows.map((row) => normalized.map((_, index) => row[index] ?? ''));
    onChange({ ...table, columns: normalized, rows: rows.length ? rows : [normalized.map(() => '')] });
  }

  function updateCell(rowIndex: number, colIndex: number, value: string) {
    onChange({
      ...table,
      rows: table.rows.map((row, currentRow) =>
        currentRow === rowIndex ? row.map((cell, currentCol) => (currentCol === colIndex ? value : cell)) : row
      )
    });
  }

  return (
    <article className="table-editor">
      <div className="table-editor-head">
        <div className="form-grid compact">
          <Field label="Table"><input value={table.name} onChange={(event) => onChange({ ...table, name: event.target.value })} /></Field>
          <Field label="Compare">
            <select value={table.compareMode} onChange={(event) => onChange({ ...table, compareMode: event.target.value as TableDraft['compareMode'] })}>
              <option value="table_equal">table_equal</option>
              <option value="contains">contains</option>
              <option value="row_count">row_count</option>
              <option value="scalar">scalar</option>
            </select>
          </Field>
          <Field label="Key columns"><input value={table.keyColumns} onChange={(event) => onChange({ ...table, keyColumns: event.target.value })} /></Field>
          <Field label="Notes"><input value={table.notes} onChange={(event) => onChange({ ...table, notes: event.target.value })} /></Field>
        </div>
        <button className="icon-button danger-icon" onClick={onRemove} aria-label={`Remove ${table.name}`} type="button"><Trash2 size={16} /></button>
      </div>

      <div className="column-tools">
        <ChipList items={columns} empty="No columns yet." />
        <button className="secondary" onClick={() => updateColumns([...columns, `COL_${columns.length + 1}`])} type="button"><Plus size={16} /> Column</button>
      </div>
      {table.sourceRef && (
        <div className="table-source-ref">
          <span>Source script</span>
          <strong>{table.sourceRef}</strong>
        </div>
      )}

      <div className="assert-grid" style={{ ['--cols' as string]: columns.length }}>
        <div className="assert-row header">
          <span>#</span>
          {columns.map((column, index) => (
            <input key={`${column}-${index}`} value={column} onChange={(event) => updateColumns(columns.map((item, current) => current === index ? event.target.value : item))} />
          ))}
          <span />
        </div>
        {table.rows.map((row, rowIndex) => (
          <div className="assert-row" key={rowIndex}>
            <span>{rowIndex + 1}</span>
            {columns.map((column, colIndex) => (
              <input key={`${rowIndex}-${column}-${colIndex}`} value={row[colIndex] ?? ''} onChange={(event) => updateCell(rowIndex, colIndex, event.target.value)} />
            ))}
            <button className="icon-button" onClick={() => onChange({ ...table, rows: table.rows.length > 1 ? table.rows.filter((_, index) => index !== rowIndex) : table.rows })} aria-label="Remove row" type="button"><Trash2 size={16} /></button>
          </div>
        ))}
      </div>

      <button className="secondary" onClick={() => onChange({ ...table, rows: [...table.rows, columns.map(() => '')] })} type="button"><Plus size={16} /> Row</button>
    </article>
  );
}

export function App() {
  return <AppContent />;
}
