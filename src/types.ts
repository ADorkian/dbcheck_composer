export type CompareMode = 'table_equal' | 'contains' | 'row_count' | 'scalar';
export type LaunchMode = 'direct' | 'scheduled';
export type TemplateType = 'TP SQL' | 'dbCheck YAML' | 'WildFly log' | 'Dynamic DBCheck' | 'Manual';

export interface DbCheckConfig {
  taskCode: string;
  codElab: string;
  catalogResources: string;
  regressionResource: string;
  runtimeText: string;
  expectedText: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  ctxRoot: string;
  db: string;
  username: string;
  password: string;
  remember: boolean;
  dockerContainer: string;
  dockerTail: string;
  akeronLogPath?: string;
}

export interface TableDraft {
  id: string;
  name: string;
  sourceKind: 'catalog' | 'template' | 'manual';
  sourceRef: string;
  compareMode: CompareMode;
  keyColumns: string;
  columns: string[];
  rows: string[][];
  notes: string;
}

export interface RegressionDraft {
  id: string;
  name: string;
  description: string;
  templateType: TemplateType;
  launchMode: LaunchMode;
  templateText: string;
  logText: string;
  launchParams: Record<string, string>;
  dbCheckConfig?: DbCheckConfig;
  tables: TableDraft[];
  notes: string;
}

export interface WorkspaceState {
  profiles: ConnectionProfile[];
  activeProfileId: string;
  drafts: RegressionDraft[];
  activeDraftId: string;
  catalog: string[];
  resultHistory: RunRecord[];
}

export interface RunRecord {
  id: string;
  at: string;
  mode: LaunchMode;
  phase: string;
  status: string;
  raw: string;
}

export interface RegressionConfigResponse {
  oidSchedule?: string;
  elabParams?: Record<string, unknown>;
  scheduleEnvelope?: Record<string, unknown>;
  template?: Record<string, unknown>;
  activeConfigs?: unknown[];
  selectedConfig?: unknown;
}

export interface FailedCheckDTO {
  checkName: string;
  assertType: string;
  expected: string;
  actual: string;
  message: string;
}

export interface RegressionExecutionResultDTO {
  executionId: string;
  taskCode: string;
  configOid: string;
  finalOutcome: 'PASSED' | 'FAILED' | 'ERROR' | string;
  legacyOutcome: 'SUCCESSO' | 'ERRORE' | 'NON_TROVATO' | string;
  dbCheckOutcome: 'PASSED' | 'FAILED' | null | string;
  legacyMessages: string[];
  dbCheckMessages: string[];
  failedChecks: FailedCheckDTO[];
}

export interface DbCheckPerimeterGenerationRequest {
  perimeterName?: string;
  sourceType?: string;
  sourceRef?: string;
  outputDirectory?: string;
  validateGeneratedFiles?: boolean;
  writeOnlyIfChanged?: boolean;
  catalog?: Record<string, unknown>;
  dbChecks?: Array<Record<string, unknown>>;
}

export interface DbCheckPerimeterArtifact {
  name: string;
  path: string;
  sha256: string;
  size: number;
  changed: boolean;
}

export interface DbCheckPerimeterGenerationResult {
  dbId: string;
  perimeterName: string;
  outputDirectory: string;
  validated: boolean;
  validationMessages: string[];
  artifacts: DbCheckPerimeterArtifact[];
}

export interface DbCheckCatalogResource {
  resource: string;
  label: string;
  group: string;
}

export interface DbCheckCatalogResponse {
  dbId: string;
  rootPath: string;
  count: number;
  resources: DbCheckCatalogResource[];
}

export interface LogEntry {
  id: string;
  at: string;
  level: 'info' | 'success' | 'error' | 'warn';
  title: string;
  detail?: string;
}
