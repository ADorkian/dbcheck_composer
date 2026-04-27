import type { WorkspaceState } from '../types';

const KEY = 'dbcheck-composer-workspace-v1';
const DEFAULT_AKERON_LOG_PATH = 'C:\\sviluppo\\wildfly-java\\log\\vulki\\akeron.log';

const TEMPLATE_TYPES = new Set(['TP SQL', 'dbCheck YAML', 'WildFly log', 'Dynamic DBCheck', 'Manual']);

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asRecordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (typeof entry === 'string') {
      acc[key] = entry;
    } else if (entry != null) {
      acc[key] = String(entry);
    }
    return acc;
  }, {});
}

function sanitizeDraftTables(tables: unknown): WorkspaceState['drafts'][number]['tables'] {
  if (!Array.isArray(tables)) return [];
  return tables
    .filter((table): table is Record<string, unknown> => Boolean(table) && typeof table === 'object')
    .map((table, index) => {
      const columns = Array.isArray(table.columns)
        ? table.columns.map((column) => asString(column).trim()).filter(Boolean)
        : [];
      const safeColumns = columns.length > 0 ? columns : ['OID'];
      const rows = Array.isArray(table.rows)
        ? table.rows
            .filter((row) => Array.isArray(row))
            .map((row) => safeColumns.map((_, colIndex) => asString((row as unknown[])[colIndex])))
        : [];
      return {
        id: asString(table.id, `table-${index + 1}`),
        name: asString(table.name),
        sourceKind: table.sourceKind === 'catalog' || table.sourceKind === 'template' || table.sourceKind === 'manual' ? table.sourceKind : 'manual',
        sourceRef: asString(table.sourceRef),
        compareMode:
          table.compareMode === 'contains' || table.compareMode === 'row_count' || table.compareMode === 'scalar'
            ? table.compareMode
            : 'table_equal',
        keyColumns: asString(table.keyColumns),
        columns: safeColumns,
        rows: rows.length > 0 ? rows : [safeColumns.map(() => '')],
        notes: asString(table.notes)
      };
    });
}

function sanitizeDrafts(drafts: unknown, fallback: WorkspaceState['drafts']): WorkspaceState['drafts'] {
  const source = Array.isArray(drafts) && drafts.length > 0 ? drafts : fallback;
  const fallbackDraft = fallback[0];

  return source
    .filter((draft): draft is Record<string, unknown> => Boolean(draft) && typeof draft === 'object')
    .map((draft, index) => {
      const dbCheckConfig = (draft.dbCheckConfig && typeof draft.dbCheckConfig === 'object' ? draft.dbCheckConfig : {}) as Record<string, unknown>;
      const hasDynamicConfig = Boolean(
        asString(dbCheckConfig.codElab).trim() ||
          asString(dbCheckConfig.catalogResources).trim() ||
          asString(dbCheckConfig.regressionResource).trim() ||
          asString(dbCheckConfig.runtimeText).trim() ||
          asString(dbCheckConfig.expectedText).trim()
      );
      const templateType = asString(draft.templateType);
      const normalizedTemplateType: WorkspaceState['drafts'][number]['templateType'] = TEMPLATE_TYPES.has(templateType)
        ? (templateType as WorkspaceState['drafts'][number]['templateType'])
        : hasDynamicConfig
          ? 'Dynamic DBCheck'
          : 'Manual';

      return {
        ...fallbackDraft,
        ...draft,
        id: asString(draft.id, `${fallbackDraft.id}-${index + 1}`),
        name: asString(draft.name, `Template ${index + 1}`),
        description: asString(draft.description),
        templateType: normalizedTemplateType,
        launchMode: draft.launchMode === 'scheduled' ? 'scheduled' : 'direct',
        templateText: asString(draft.templateText),
        logText: asString(draft.logText),
        launchParams: asRecordOfStrings(draft.launchParams),
        dbCheckConfig: {
          taskCode: asString(dbCheckConfig.taskCode, 'REGR_TEST'),
          codElab: asString(dbCheckConfig.codElab),
          catalogResources: asString(dbCheckConfig.catalogResources),
          regressionResource: asString(dbCheckConfig.regressionResource),
          runtimeText: asString(dbCheckConfig.runtimeText),
          expectedText: asString(dbCheckConfig.expectedText)
        },
        tables: sanitizeDraftTables(draft.tables),
        notes: asString(draft.notes)
      };
    });
}

function sanitizeProfiles(profiles: unknown, fallback: WorkspaceState['profiles']): WorkspaceState['profiles'] {
  const source = Array.isArray(profiles) && profiles.length > 0 ? profiles : fallback;
  const fallbackProfile = fallback[0];

  return source
    .filter((profile): profile is Record<string, unknown> => Boolean(profile) && typeof profile === 'object')
    .map((profile, index) => ({
      ...fallbackProfile,
      ...profile,
      id: asString(profile.id, `${fallbackProfile.id}-${index + 1}`),
      name: asString(profile.name, index === 0 ? fallbackProfile.name : `Profile ${index + 1}`),
      host: asString(profile.host, fallbackProfile.host),
      port: asString(profile.port, fallbackProfile.port),
      ctxRoot: asString(profile.ctxRoot, fallbackProfile.ctxRoot),
      db: asString(profile.db, fallbackProfile.db),
      username: asString(profile.username, fallbackProfile.username),
      password: asString(profile.password),
      remember: profile.remember === true,
      dockerContainer: asString(profile.dockerContainer, fallbackProfile.dockerContainer),
      dockerTail: asString(profile.dockerTail, fallbackProfile.dockerTail),
      akeronLogPath: asString(profile.akeronLogPath, fallbackProfile.akeronLogPath || DEFAULT_AKERON_LOG_PATH)
    }));
}

export function loadWorkspaceState(fallback: WorkspaceState): WorkspaceState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<WorkspaceState>;
    return {
      ...fallback,
      ...parsed,
      profiles: sanitizeProfiles(parsed.profiles, fallback.profiles),
      drafts: sanitizeDrafts(parsed.drafts, fallback.drafts),
      catalog: Array.isArray(parsed.catalog) ? parsed.catalog : fallback.catalog,
      resultHistory: Array.isArray(parsed.resultHistory) ? parsed.resultHistory : fallback.resultHistory
    };
  } catch {
    return fallback;
  }
}

export function saveWorkspaceState(state: WorkspaceState): void {
  const sanitized = {
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.remember ? profile : { ...profile, password: '' }
    )
  };
  localStorage.setItem(KEY, JSON.stringify(sanitized));
}

export function clearWorkspaceState(): void {
  localStorage.removeItem(KEY);
}
