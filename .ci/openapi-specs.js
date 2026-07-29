'use strict';

const PERSONAL_STATEMENT_PATH = '/personal/statement/{account}/{from}/{to}';
const VERSION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function isCompatibleSpec(target, candidate) {
  if (normalizeTitle(target.currentSpec?.info?.title) !== normalizeTitle(candidate?.info?.title)) {
    return false;
  }

  // The legacy currency-only document has the same title as the personal API.
  return (
    target.fileName !== 'open_personal_api.json' ||
    Boolean(candidate?.paths?.[PERSONAL_STATEMENT_PATH])
  );
}

function selectLatestCompatibleSpec(candidates) {
  return candidates.reduce((latest, candidate) => {
    const candidateVersion = String(candidate?.info?.version || '').trim();
    const latestVersion = String(latest?.info?.version || '').trim();

    return VERSION_COLLATOR.compare(candidateVersion, latestVersion) > 0 ? candidate : latest;
  });
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
    const titleKey = normalizeTitle(expected.currentSpec?.info?.title);
    const candidates = discoveredByTitle.get(titleKey) || [];
    const compatibleCandidates = candidates.filter((candidate) => isCompatibleSpec(expected, candidate));

    if (compatibleCandidates.length === 0) {
      unmatchedExpected.push({
        fileName: expected.fileName,
        title: expected.currentSpec?.info?.title || 'Untitled',
      });
      continue;
    }

    const selectedSpec = selectLatestCompatibleSpec(compatibleCandidates);
    candidates.splice(candidates.indexOf(selectedSpec), 1);
    matches.set(expectedIndex, { discoveredSpec: selectedSpec });

    if (!usedDiscoveredByTitle.has(titleKey)) {
      usedDiscoveredByTitle.set(titleKey, []);
    }
    usedDiscoveredByTitle.get(titleKey).push(selectedSpec);
  }

  const duplicatedDiscovered = [];
  for (const [titleKey, remainingSpecs] of discoveredByTitle.entries()) {
    const usedSpecs = usedDiscoveredByTitle.get(titleKey) || [];
    const allSpecs = [...usedSpecs, ...remainingSpecs];

    if (allSpecs.length > 1) {
      duplicatedDiscovered.push({
        title: allSpecs[0]?.info?.title || 'Untitled',
        count: allSpecs.length,
        versions: allSpecs.map((spec) => spec?.info?.version || 'unknown'),
        usedVersions: usedSpecs.map((spec) => spec?.info?.version || 'unknown'),
      });
    }
  }

  const unmatchedDiscovered = [];
  for (const [titleKey, remainingSpecs] of discoveredByTitle.entries()) {
    if (expectedTitleKeys.has(titleKey)) {
      continue;
    }

    for (const spec of remainingSpecs) {
      unmatchedDiscovered.push(spec?.info?.title || 'Untitled');
    }
  }

  return { matches, unmatchedExpected, unmatchedDiscovered, duplicatedDiscovered };
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

module.exports = {
  matchDiscoveredSpecs,
  sanitizeSpecForPersist,
};
