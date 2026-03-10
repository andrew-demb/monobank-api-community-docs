#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const API_DOCS_URL = 'https://monobank.ua/api-docs';
const OASDIFF_TENANT_ID = 'b4153952-9781-4596-8bf9-fd286d626506';
const SCRIPT_DIR = __dirname;
const REPO_ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const CACHE_ROOT_DIR = path.join(SCRIPT_DIR, '.cache');
const CACHE_RAW_DIR = path.join(CACHE_ROOT_DIR, 'raw');
const RESULT_SPECS_DIR = path.join(SCRIPT_DIR, '.result');

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'monobank-api-community-docs-spec-toolkit',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}. HTTP status: ${response.status}`);
  }

  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`Fetched empty response body from ${url}`);
  }

  return body;
}

function discoverMainScriptPath(html) {
  // Extract only the <head> block to avoid matching unrelated scripts in body content.
  // Regex details:
  // - <head[^>]*> : opening <head> tag with optional attributes
  // - ([\s\S]*?)  : non-greedy capture of any chars/newlines inside <head>
  // - </head>     : closing tag
  // - /i          : case-insensitive HTML tag matching
  const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] || html;

  // Find the Vite main bundle path for docs UI.
  // Regex details:
  // - /assets/main- : required prefix
  // - [^"'`\s>]+    : hash/filename chars until quote, whitespace, backtick or '>'
  // - \.js\b        : ".js" extension with word boundary
  const mainScriptPath = head.match(/\/assets\/main-[^"'`\s>]+\.js\b/)?.[0];

  if (!mainScriptPath) {
    throw new Error('Could not find main script path in API docs HTML');
  }

  return mainScriptPath;
}

function discoverOpenApiScriptPath(mainScriptSourceCode) {
  // Find openapi data bundle reference inside main script.
  // Regex details:
  // - (?:\/)?                 : optional leading slash
  // - assets/openapi-data-    : required prefix
  // - [^"'`\s)]+              : filename chars until quote, whitespace, backtick or ')'
  // - \.js\b                  : ".js" extension with word boundary
  const openApiScriptPath =
    mainScriptSourceCode.match(/(?:\/)?assets\/openapi-data-[^"'`\s)]+\.js\b/)?.[0];

  if (!openApiScriptPath) {
    throw new Error('Could not find openapi-data script path in main script');
  }

  return openApiScriptPath.startsWith('/') ? openApiScriptPath : `/${openApiScriptPath}`;
}

function extractOpenApiFromJs(sourceCode) {
  const sanitizedSource = sourceCode
    // Remove ESM named export tail, e.g.:
    // export { a as x, b as y };
    // Regex details:
    // - \bexport\s*\{   : "export" followed by "{"
    // - [\s\S]*?        : non-greedy anything inside export list
    // - \}\s*;?\s*$     : closing "}", optional semicolon, trailing whitespace to end
    // - /m              : multiline mode so $ works at final line boundary
    .replace(/\bexport\s*\{[\s\S]*?\}\s*;?\s*$/m, '')
    // Remove `export default` token if present so VM can execute as plain script.
    // Regex details:
    // - \bexport\s+default\s+ : exact keyword sequence with flexible whitespace
    // - /g                    : replace all occurrences
    .replace(/\bexport\s+default\s+/g, '');

  const context = Object.create(null);
  vm.createContext(context);
  vm.runInContext(sanitizedSource, context, {
    timeout: 10000,
    displayErrors: true,
  });

  const contextValues = [];
  for (const key of Reflect.ownKeys(context)) {
    contextValues.push(context[key]);
  }

  const specs = [];
  const seen = new Set();
  for (const value of contextValues) {
    if (
      value &&
      typeof value === 'object' &&
      typeof value.openapi === 'string' &&
      value.paths &&
      typeof value.paths === 'object' &&
      value.components &&
      typeof value.components === 'object'
    ) {
      if (!seen.has(value)) {
        seen.add(value);
        specs.push(value);
      }
    }
  }

  if (specs.length === 0) {
    throw new Error('Could not find OpenAPI object in evaluated JS payload');
  }

  return specs;
}

async function readExpectedSpecTargets() {
  const specsDir = path.join(REPO_ROOT_DIR, 'specs');
  const entries = await fs.readdir(specsDir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const targets = [];
  for (const fileName of fileNames) {
    const targetPath = path.join(specsDir, fileName);
    const currentRaw = await fs.readFile(targetPath, 'utf8');
    targets.push({
      fileName,
      targetPath,
      tmpResultPath: path.join(RESULT_SPECS_DIR, fileName),
      diffResultPath: path.join(RESULT_SPECS_DIR, fileName.replace(/\.json$/i, '.diff.md')),
      currentSpec: JSON.parse(currentRaw),
    });
  }

  return targets;
}

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function matchDiscoveredSpecs(expectedTargets, discoveredSpecs) {
  const matches = new Map();
  const unmatchedExpected = [];
  const expectedTitleKeys = new Set(
    expectedTargets.map((target) => normalizeTitle(target.currentSpec?.info?.title))
  );
  const usedDiscoveredByTitle = new Map();

  const discoveredByTitle = new Map();
  for (const discoveredSpec of discoveredSpecs) {
    const titleKey = normalizeTitle(discoveredSpec?.info?.title);
    if (!discoveredByTitle.has(titleKey)) {
      discoveredByTitle.set(titleKey, []);
    }
    discoveredByTitle.get(titleKey).push(discoveredSpec);
  }

  for (const [expectedIndex, expected] of expectedTargets.entries()) {
    const expectedTitleKey = normalizeTitle(expected.currentSpec?.info?.title);
    const candidates = discoveredByTitle.get(expectedTitleKey);

    if (!candidates || candidates.length === 0) {
      unmatchedExpected.push({
        fileName: expected.fileName,
        title: expected.currentSpec?.info?.title || 'Untitled',
      });
      continue;
    }

    const selectedSpec = candidates.shift();
    matches.set(expectedIndex, { discoveredSpec: selectedSpec });

    if (!usedDiscoveredByTitle.has(expectedTitleKey)) {
      usedDiscoveredByTitle.set(expectedTitleKey, []);
    }
    usedDiscoveredByTitle.get(expectedTitleKey).push(selectedSpec);
  }

  const duplicatedDiscovered = [];
  for (const [titleKey, specsWithSameTitle] of discoveredByTitle.entries()) {
    const matchedTitle = expectedTitleKeys.has(titleKey);
    const usedSpecs = usedDiscoveredByTitle.get(titleKey) || [];
    const consumedCount = usedSpecs.length;
    const totalCount = specsWithSameTitle.length + consumedCount;

    if (totalCount > 1) {
      const title = specsWithSameTitle[0]?.info?.title || 'Untitled';
      const allSpecs = [...usedSpecs, ...specsWithSameTitle];
      const versions = allSpecs.map((spec) => spec?.info?.version || 'unknown');
      const usedVersions = usedSpecs.map((spec) => spec?.info?.version || 'unknown');
      duplicatedDiscovered.push({ title, count: totalCount, versions, usedVersions });
    }
  }

  const unmatchedDiscovered = [];
  for (const [titleKey, specsWithSameTitle] of discoveredByTitle.entries()) {
    if (expectedTitleKeys.has(titleKey)) {
      continue;
    }

    for (const spec of specsWithSameTitle) {
      unmatchedDiscovered.push(spec?.info?.title || 'Untitled');
    }
  }

  return { matches, unmatchedExpected, unmatchedDiscovered, duplicatedDiscovered };
}

async function clearRunDirectories() {
  await Promise.all([
    fs.rm(CACHE_ROOT_DIR, { recursive: true, force: true }),
    fs.rm(RESULT_SPECS_DIR, { recursive: true, force: true }),
  ]);
}

async function ensureOutputDirs() {
  await Promise.all([
    fs.mkdir(CACHE_RAW_DIR, { recursive: true }),
    fs.mkdir(RESULT_SPECS_DIR, { recursive: true }),
  ]);
}

async function writeRawCacheFiles(mainScriptUrl, mainScriptSourceCode, openApiScriptUrl, openApiSourceCode) {
  const mainRawPath = path.join(CACHE_RAW_DIR, path.basename(new URL(mainScriptUrl).pathname));
  const openApiRawPath = path.join(CACHE_RAW_DIR, path.basename(new URL(openApiScriptUrl).pathname));

  await fs.writeFile(mainRawPath, mainScriptSourceCode, 'utf8');
  await fs.writeFile(openApiRawPath, openApiSourceCode, 'utf8');
}

function sanitizeSpecForPersist(spec) {
  const clonedSpec = JSON.parse(JSON.stringify(spec));
  const description = clonedSpec?.info?.description;

  if (typeof description === 'string') {
    clonedSpec.info.description = description.replace(
      /https:\/\/t\.me\/joinchat\/[^\s)"'`]+/g,
      'REDACTED_TGLINK'
    );
  }

  return clonedSpec;
}

async function generateHumanReadableDiff(oldSpec, newSpec, fileName) {
  const endpoint = `https://api.oasdiff.com/tenants/${OASDIFF_TENANT_ID}/diff`;
  const baseJson = `${JSON.stringify(oldSpec, null, 2)}\n`;
  const revisionJson = `${JSON.stringify(newSpec, null, 2)}\n`;
  const form = new FormData();
  form.append('base', new Blob([baseJson], { type: 'application/json' }), `${fileName}.old.json`);
  form.append(
    'revision',
    new Blob([revisionJson], { type: 'application/json' }),
    `${fileName}.new.json`
  );

  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    headers: {
      'user-agent': 'monobank-api-community-docs-spec-toolkit',
      accept: 'text/markdown',
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `oasdiff diff request failed for ${fileName}. HTTP ${response.status}. Body: ${body.slice(0, 600)}`
    );
  }

  return body.endsWith('\n') ? body : `${body}\n`;
}

async function writeMatchedSpec(target, discoveredSpec) {
  const oldSpec = target.currentSpec;
  const sanitizedSpec = sanitizeSpecForPersist(discoveredSpec);
  const changelog = await generateHumanReadableDiff(oldSpec, sanitizedSpec, target.fileName);
  const specJson = `${JSON.stringify(sanitizedSpec, null, 2)}\n`;
  await fs.writeFile(target.tmpResultPath, specJson, 'utf8');
  await fs.writeFile(target.diffResultPath, changelog, 'utf8');
  await fs.writeFile(target.targetPath, specJson, 'utf8');
  return `${target.fileName} <= "${discoveredSpec?.info?.title || 'Untitled'}"`;
}

async function main() {
  await clearRunDirectories();

  // fetch doc landing page - search main JS entrypoint URL
  const docsHtml = await fetchText(API_DOCS_URL);
  const mainScriptPath = discoverMainScriptPath(docsHtml);
  const mainScriptUrl = new URL(mainScriptPath, API_DOCS_URL).toString();

  // fetch main JS entrypoint - search OpenAPI JS entrypoint URL
  const mainScriptSourceCode = await fetchText(mainScriptUrl);
  const openApiScriptPath = discoverOpenApiScriptPath(mainScriptSourceCode);
  const openApiScriptUrl = new URL(openApiScriptPath, API_DOCS_URL).toString();

  // fetch OpenAPI JS entrypoint - extract OpenAPI specs
  const openApiSourceCode = await fetchText(openApiScriptUrl);
  const discoveredSpecs = extractOpenApiFromJs(openApiSourceCode);

  // search for expected specs in the project
  const expectedTargets = await readExpectedSpecTargets();
  // match discovered specs to expected specs
  const { matches, unmatchedExpected, unmatchedDiscovered, duplicatedDiscovered } =
    matchDiscoveredSpecs(
    expectedTargets,
    discoveredSpecs
    );

  await ensureOutputDirs();
  await writeRawCacheFiles(mainScriptUrl, mainScriptSourceCode, openApiScriptUrl, openApiSourceCode);

  const updatedFiles = [];
  for (const [expectedIndex, target] of expectedTargets.entries()) {
    const match = matches.get(expectedIndex);
    if (!match) {
      continue;
    }
    updatedFiles.push(await writeMatchedSpec(target, match.discoveredSpec));
  }

  const unmatchedExpectedOutput =
    unmatchedExpected.length === 0
      ? '- none'
      : unmatchedExpected.map((item) => `- ${item.fileName} (title: "${item.title}")`).join('\n');
  const unmatchedDiscoveredOutput =
    unmatchedDiscovered.length === 0
      ? '- none'
      : unmatchedDiscovered.map((title) => `- "${title}"`).join('\n');
  const duplicatedDiscoveredOutput =
    duplicatedDiscovered.length === 0
      ? '- none'
      : duplicatedDiscovered
          .map(
            (item) =>
              `- "${item.title}" (x${item.count}) versions: [${item.versions.join(', ')}], used: [${item.usedVersions.join(', ')}]`
          )
          .join('\n');

  process.stdout.write(
    `Specs updated.

Docs: ${API_DOCS_URL}
Main script: ${mainScriptUrl}
OpenAPI script: ${openApiScriptUrl}

Targets:
${updatedFiles.length === 0 ? '- none' : `- ${updatedFiles.join('\n- ')}`}

Unmatched expected titles:
${unmatchedExpectedOutput}

Unmatched discovered titles:
${unmatchedDiscoveredOutput}

Duplicated discovered titles in source:
${duplicatedDiscoveredOutput}

Result dir: ${RESULT_SPECS_DIR}
Target dir: ${path.join(REPO_ROOT_DIR, 'specs')}
`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
