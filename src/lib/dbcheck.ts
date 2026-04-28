import type { DbCheckConfig } from '../types';

export function createBlankDbCheckConfig(): DbCheckConfig {
  return {
    taskCode: 'REGR_TEST',
    codElab: '',
    catalogResources: '',
    regressionResource: '',
    runtimeText: '',
    expectedText: ''
  };
}

export function createScorecardDbCheckSample(): DbCheckConfig {
  return {
    taskCode: 'REGR_TEST',
    codElab: 'SCORECARD_DBCHECK',
    catalogResources: 'generated-applicativo/beneficiari.yaml, generated-applicativo/misure-dati-kpi-qnt.yaml',
    regressionResource: 'scorecard/scorecard-regression.yaml',
    runtimeText: 'payeeId=12034\ncodMisura=KPI_SALES_Q1\nexecutionId=SC_2026_04_27_01',
    expectedText: 'expectedRows=1\nexpectedValue=87.50\nexpectedTolerance=0.01'
  };
}

export function normalizeDbCheckConfig(config?: Partial<DbCheckConfig>): DbCheckConfig {
  return { ...createBlankDbCheckConfig(), ...(config ?? {}) };
}

function parseKeyValueText(text: string): Record<string, string> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes('='))
    .reduce<Record<string, string>>((acc, line) => {
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key) acc[key] = value;
      return acc;
    }, {});
}


export function buildDbCheckLaunchParams(config: DbCheckConfig): Record<string, string> {
  const normalized = normalizeDbCheckConfig(config);
  const params: Record<string, string> = {};

  if (normalized.codElab.trim()) {
    params['e.codElab'] = normalized.codElab.trim();
  }
  if (normalized.catalogResources.trim()) {
    params['dbcheck.catalogResources'] = normalized.catalogResources.trim();
  }
  if (normalized.regressionResource.trim()) {
    params['dbcheck.regressionResource'] = normalized.regressionResource.trim();
  }

  for (const [key, value] of Object.entries(parseKeyValueText(normalized.runtimeText))) {
    params[`dbcheck.runtime.${key}`] = value;
  }

  for (const [key, value] of Object.entries(parseKeyValueText(normalized.expectedText))) {
    params[`dbcheck.expected.${key}`] = value;
  }

  return params;
}

export function buildDbCheckParametriText(config: DbCheckConfig): string {
  return Object.entries(buildDbCheckLaunchParams(config))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function validateDbCheckConfig(config: DbCheckConfig): string[] {
  const normalized = normalizeDbCheckConfig(config);
  const missing: string[] = [];

  if (!normalized.codElab.trim() && !normalized.taskCode.trim()) {
    missing.push('e.codElab or task fallback');
  }
  if (!normalized.catalogResources.trim()) {
    missing.push('dbcheck.catalogResources');
  }
  if (!normalized.regressionResource.trim()) {
    missing.push('dbcheck.regressionResource');
  }

  return missing;
}
