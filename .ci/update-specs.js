#!/usr/bin/env node

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  API_DOCS_URL,
  OPENAPI_SPECS_URL,
  PERSONAL_API_DOCS_URL,
  fetchPublishedSpecs,
} = require('./openapi-sources');
const { matchDiscoveredSpecs, sanitizeSpecForPersist } = require('./openapi-specs');

const SCRIPT_DIR = __dirname;
const REPO_ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const CACHE_ROOT_DIR = path.join(SCRIPT_DIR, '.cache');
const CACHE_RAW_DIR = path.join(CACHE_ROOT_DIR, 'raw');
const RESULT_SPECS_DIR = path.join(SCRIPT_DIR, '.result');
const OASDIFF_DOCKER_IMAGE = process.env.OASDIFF_DOCKER_IMAGE || 'tufin/oasdiff:latest';
const OASDIFF_DOCKER_TIMEOUT_MS = Number(process.env.OASDIFF_DOCKER_TIMEOUT_MS) || 60000;
const execFileAsync = promisify(execFile);
const UNTRACKED_SPEC_TITLES = new Set(['API для роботи з рахунками юридичних осіб']);

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

async function writeRawCacheFiles(publishedSpecs) {
  await Promise.all([
    fs.writeFile(
      path.join(CACHE_RAW_DIR, 'openapi-specs.json'),
      `${JSON.stringify(publishedSpecs.dynamicResponse, null, 2)}\n`,
      'utf8'
    ),
    fs.writeFile(
      path.join(CACHE_RAW_DIR, path.basename(new URL(publishedSpecs.legacySourceUrl).pathname)),
      publishedSpecs.legacySourceCode,
      'utf8'
    ),
    fs.writeFile(path.join(CACHE_RAW_DIR, 'personal-api-docs.html'), publishedSpecs.personalDocsHtml, 'utf8'),
  ]);
}

async function generateHumanReadableDiff(oldSpec, newSpec, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const inputDir = path.join(CACHE_ROOT_DIR, 'oasdiff', safeName);
  const baseFile = path.join(inputDir, 'base.json');
  const revisionFile = path.join(inputDir, 'revision.json');

  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(baseFile, `${JSON.stringify(oldSpec, null, 2)}\n`, 'utf8');
  await fs.writeFile(revisionFile, `${JSON.stringify(newSpec, null, 2)}\n`, 'utf8');

  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${inputDir}:/work`,
    OASDIFF_DOCKER_IMAGE,
    'changelog',
    '/work/base.json',
    '/work/revision.json',
    '--format',
    'markdown',
  ];

  try {
    const { stdout } = await execFileAsync('docker', dockerArgs, {
      timeout: OASDIFF_DOCKER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const normalizedOutput = (stdout || '').trim();
    return normalizedOutput ? `${normalizedOutput}\n` : 'No changelog changes\n';
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    const signal =
      error && typeof error === 'object' && 'signal' in error && error.signal
        ? String(error.signal)
        : 'none';
    const stderrSnippet = stderr.trim().slice(0, 1000) || '(empty)';
    const stdoutSnippet = stdout.trim().slice(0, 1000) || '(empty)';
    const dockerCmd = `docker ${dockerArgs.join(' ')}`;
    const dockerError = new Error(
      `oasdiff docker changelog failed for ${fileName}. exit=${code}, signal=${signal}. stderr: ${stderrSnippet}`
    );
    dockerError.fileReason =
      `oasdiff docker changelog failed for ${fileName}. exit=${code}, signal=${signal}. ` +
      `command: ${dockerCmd}. stderr: ${stderrSnippet}. stdout: ${stdoutSnippet}`;
    throw dockerError;
  }
}

function buildFallbackChangelog(fileName, oldSpec, newSpec, reason) {
  const oldVersion = oldSpec?.info?.version || 'unknown';
  const newVersion = newSpec?.info?.version || 'unknown';
  const oldPathCount = oldSpec?.paths ? Object.keys(oldSpec.paths).length : 0;
  const newPathCount = newSpec?.paths ? Object.keys(newSpec.paths).length : 0;

  return (
    `# Changelog unavailable\n\n` +
    `Could not generate human-readable diff for \`${fileName}\` via oasdiff.\n\n` +
    `Reason: ${reason}\n\n` +
    `## Quick summary\n\n` +
    `- Previous version: \`${oldVersion}\`\n` +
    `- New version: \`${newVersion}\`\n` +
    `- Previous path count: \`${oldPathCount}\`\n` +
    `- New path count: \`${newPathCount}\`\n`
  );
}

async function generateChangelogForSpec(target, oldSpec, sanitizedSpec) {
  try {
    return await generateHumanReadableDiff(oldSpec, sanitizedSpec, target.fileName);
  } catch (error) {
    const reasonForStderr = error instanceof Error ? error.message : String(error);
    const reasonForFile =
      error && typeof error === 'object' && 'fileReason' in error
        ? String(error.fileReason)
        : reasonForStderr;
    process.stderr.write(
      `Warning: failed to generate changelog for ${target.fileName}. Using fallback summary. ${reasonForStderr}\n`
    );
    return buildFallbackChangelog(target.fileName, oldSpec, sanitizedSpec, reasonForFile);
  }
}

async function writeMatchedSpec(target, discoveredSpec) {
  const oldSpec = target.currentSpec;
  const sanitizedSpec = sanitizeSpecForPersist(discoveredSpec);
  const changelog = await generateChangelogForSpec(target, oldSpec, sanitizedSpec);

  const oldSpecJson = `${JSON.stringify(oldSpec, null, 2)}\n`;
  const specJson = `${JSON.stringify(sanitizedSpec, null, 2)}\n`;
  const changed = oldSpecJson !== specJson;
  await fs.writeFile(target.tmpResultPath, specJson, 'utf8');
  await fs.writeFile(
    target.diffResultPath,
    changelog.endsWith('\n') ? changelog : `${changelog}\n`,
    'utf8'
  );
  await fs.writeFile(target.targetPath, specJson, 'utf8');
  return {
    fileName: target.fileName,
    title: discoveredSpec?.info?.title || 'Untitled',
    changed,
  };
}

async function main() {
  await clearRunDirectories();

  const publishedSpecs = await fetchPublishedSpecs();
  const trackedSpecs = publishedSpecs.specs.filter(
    (spec) => !UNTRACKED_SPEC_TITLES.has(spec?.info?.title)
  );

  // search for expected specs in the project
  const expectedTargets = await readExpectedSpecTargets();
  // match discovered specs to expected specs
  const { matches, unmatchedExpected, unmatchedDiscovered, duplicatedDiscovered } =
    matchDiscoveredSpecs(expectedTargets, trackedSpecs);

  await ensureOutputDirs();
  await writeRawCacheFiles(publishedSpecs);

  const targetResults = [];
  for (const [expectedIndex, target] of expectedTargets.entries()) {
    const match = matches.get(expectedIndex);
    if (!match) {
      continue;
    }
    targetResults.push(await writeMatchedSpec(target, match.discoveredSpec));
  }

  const changedTargets = targetResults.filter((item) => item.changed);
  const unchangedTargets = targetResults.filter((item) => !item.changed);
  const changedTargetsOutput =
    changedTargets.length === 0
      ? '- none'
      : changedTargets.map((item) => `- ${item.fileName} <= "${item.title}"`).join('\n');
  const unchangedTargetsOutput =
    unchangedTargets.length === 0
      ? '- none'
      : unchangedTargets.map((item) => `- ${item.fileName} <= "${item.title}"`).join('\n');

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
Dynamic OpenAPI source: ${OPENAPI_SPECS_URL}
Legacy OpenAPI source: ${publishedSpecs.legacySourceUrl}
Personal OpenAPI source: ${PERSONAL_API_DOCS_URL}

Changed targets:
${changedTargetsOutput}

Unchanged targets:
${unchangedTargetsOutput}

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
