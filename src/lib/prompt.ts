import { buildBaseUrl } from './api';
import { buildDbCheckParametriText, normalizeDbCheckConfig } from './dbcheck';
import type { ConnectionProfile, RegressionDraft } from '../types';

export function buildPromptBundle(profile: ConnectionProfile, draft: RegressionDraft): string {
  const lines: string[] = [];
  lines.push('# DbCheck Composer bundle');
  lines.push('');
  lines.push('Use this bundle to drive Codex CLI / IDE or to hand off the test draft later.');
  lines.push('');
  lines.push('## Connection');
  lines.push(`- baseUrl: ${buildBaseUrl(profile)}`);
  lines.push(`- dbId: ${profile.db}`);
  lines.push(`- username: ${profile.username}`);
  lines.push(`- ctxRoot: ${profile.ctxRoot}`);
  lines.push('');
  lines.push('## Draft');
  lines.push(`- name: ${draft.name}`);
  lines.push(`- templateType: ${draft.templateType}`);
  lines.push(`- launchMode: ${draft.launchMode}`);
  lines.push(`- tables: ${draft.tables.length}`);
  lines.push('');
  if (draft.dbCheckConfig) {
    const config = normalizeDbCheckConfig(draft.dbCheckConfig);
    lines.push('## Dynamic DBCheck Contract');
    lines.push(`- ConfigRegressionTestContainer.task: ${config.taskCode || '-'}`);
    lines.push(`- e.codElab: ${config.codElab || '-'}`);
    lines.push(`- dbcheck.catalogResources: ${config.catalogResources || '-'}`);
    lines.push(`- dbcheck.regressionResource: ${config.regressionResource || '-'}`);
    lines.push('');
    lines.push('```properties');
    lines.push(buildDbCheckParametriText(config) || '# empty');
    lines.push('```');
    lines.push('');
  }
  lines.push('## Tables');
  for (const table of draft.tables) {
    lines.push(`- ${table.name} | compare=${table.compareMode} | keys=${table.keyColumns || '-'}`);
    lines.push(`  - columns: ${table.columns.join(', ') || '-'}`);
    lines.push(`  - rows: ${table.rows.length}`);
  }
  lines.push('');
  lines.push('## Launch Params');
  const params = Object.entries(draft.launchParams);
  if (params.length === 0) {
    lines.push('- none parsed yet');
  } else {
    for (const [key, value] of params) {
      lines.push(`- ${key} = ${value}`);
    }
  }
  lines.push('');
  lines.push('## Next action');
  lines.push('Create or adjust the dbCheck artifacts from this draft, then run with current BE API flow.');
  return lines.join('\n');
}

export function buildDraftJson(profile: ConnectionProfile, draft: RegressionDraft): string {
  return JSON.stringify(
    {
      profile,
      draft
    },
    null,
    2
  );
}

function parseKeyList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
    .filter(Boolean);
}

export function buildMissingArtifactsPrompt(
  profile: ConnectionProfile,
  draft: RegressionDraft,
  options: { missingCatalogResources: string[]; regressionResourceMissing: boolean }
): string {
  const config = normalizeDbCheckConfig(draft.dbCheckConfig);
  const regressionResource = config.regressionResource.trim() || 'scorecard/scorecard-regression.yaml';
  const runtimeKeys = parseKeyList(config.runtimeText);
  const expectedKeys = parseKeyList(config.expectedText);
  const lines: string[] = [];

  lines.push('# DBCheck Missing Artifacts - BE Implementation Prompt');
  lines.push('');
  lines.push('Create TP DBCheck artifacts for this regression scenario.');
  lines.push('');
  lines.push('## Context');
  lines.push(`- baseUrl: ${buildBaseUrl(profile)}`);
  lines.push(`- dbId: ${profile.db}`);
  lines.push(`- draftName: ${draft.name}`);
  lines.push(`- codElab: ${config.codElab || '-'}`);
  lines.push('');
  lines.push('## Missing artifacts');
  if (options.missingCatalogResources.length === 0 && !options.regressionResourceMissing) {
    lines.push('- none explicitly missing, verify the paths and regenerate if needed');
  } else {
    for (const resource of options.missingCatalogResources) {
      lines.push(`- catalog: ${resource}`);
    }
    if (options.regressionResourceMissing) {
      lines.push(`- regression: ${regressionResource}`);
    }
  }
  lines.push('');
  lines.push('## Required output');
  lines.push('- Add/extend dataset catalog YAML(s) for missing catalog resources.');
  lines.push(`- Add regression YAML at: ${regressionResource}`);
  lines.push('- Keep Java code unchanged unless strictly necessary.');
  lines.push('');
  lines.push('## Regression YAML skeleton');
  lines.push('```yaml');
  lines.push('dbChecks:');
  lines.push('  - name: scorecard_non_regression_count');
  lines.push('    dataset: <dataset_name>');
  lines.push('    filter:');
  lines.push('      eq:');
  if (runtimeKeys.length === 0) {
    lines.push('        payeeOid: ${payeeOid}');
  } else {
    runtimeKeys.forEach((key) => {
      lines.push(`        ${key}: \${${key}}`);
    });
  }
  lines.push('    assert:');
  lines.push('      count: ${expectedRows}');
  lines.push('  - name: scorecard_non_regression_values');
  lines.push('    dataset: <dataset_name>');
  lines.push('    filter:');
  lines.push('      eq:');
  if (runtimeKeys.length === 0) {
    lines.push('        payeeOid: ${payeeOid}');
  } else {
    runtimeKeys.forEach((key) => {
      lines.push(`        ${key}: \${${key}}`);
    });
  }
  lines.push('    assert:');
  lines.push('      firstRowEquals:');
  if (expectedKeys.length === 0) {
    lines.push('        score: ${expectedScore}');
  } else {
    expectedKeys.forEach((key) => {
      lines.push(`        ${key}: \${${key}}`);
    });
  }
  lines.push('```');
  lines.push('');
  lines.push('## Runtime and expected keys from current draft');
  lines.push(`- runtime: ${runtimeKeys.length ? runtimeKeys.join(', ') : '(none)'}`);
  lines.push(`- expected: ${expectedKeys.length ? expectedKeys.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('## Launch params snapshot');
  lines.push('```properties');
  lines.push(buildDbCheckParametriText(config) || '# empty');
  lines.push('```');

  return lines.join('\n');
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
