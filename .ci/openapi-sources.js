'use strict';

const vm = require('node:vm');

const API_DOCS_URL = 'https://monobank.ua/api-docs';
const OPENAPI_SPECS_URL = 'https://monobank.ua/api-front/openapi/specs';
const PERSONAL_API_DOCS_URL = 'https://api.monobank.ua/docs/index.html';
const REQUEST_HEADERS = {
  'user-agent': 'monobank-api-community-docs-spec-toolkit',
};

async function fetchText(url) {
  const response = await fetch(url, { headers: REQUEST_HEADERS, redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}. HTTP status: ${response.status}`);
  }

  const body = await response.text();
  if (!body.trim()) {
    throw new Error(`Fetched empty response body from ${url}`);
  }

  return body;
}

async function fetchOpenApiSpecs() {
  const response = await fetch(OPENAPI_SPECS_URL, {
    headers: REQUEST_HEADERS,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${OPENAPI_SPECS_URL}. HTTP status: ${response.status}`);
  }

  const body = await response.json();
  const specs = body?.result?.specs;
  if (!Array.isArray(specs) || specs.some((item) => !item?.spec || typeof item.spec !== 'object')) {
    throw new Error(`Could not find OpenAPI specs in response from ${OPENAPI_SPECS_URL}`);
  }

  return { response: body, specs: specs.map((item) => item.spec) };
}

function discoverAssetPath(sourceCode, prefix) {
  const assetPath = sourceCode.match(
    new RegExp(`(?:\\./|/assets/)${prefix}-[A-Za-z0-9_-]+\\.js\\b`)
  )?.[0];

  if (!assetPath) {
    throw new Error(`Could not find ${prefix} bundle reference`);
  }

  return assetPath.startsWith('./') ? `/assets/${assetPath.slice(2)}` : assetPath;
}

function resolveBundleUrl(sourceCode, bundleName) {
  return new URL(discoverAssetPath(sourceCode, bundleName), API_DOCS_URL).toString();
}

function extractOpenApiFromJs(sourceCode) {
  const sanitizedSource = sourceCode
    .replace(/\bexport\s*\{[\s\S]*?\}\s*;?\s*$/m, '')
    .replace(/\bexport\s+default\s+/g, '');
  const context = Object.create(null);
  vm.createContext(context);
  vm.runInContext(sanitizedSource, context, { timeout: 10000, displayErrors: true });

  const specs = [];
  const seen = new Set();
  for (const key of Reflect.ownKeys(context)) {
    const value = context[key];
    if (
      value &&
      typeof value === 'object' &&
      typeof value.openapi === 'string' &&
      value.paths &&
      typeof value.paths === 'object' &&
      value.components &&
      typeof value.components === 'object' &&
      !seen.has(value)
    ) {
      seen.add(value);
      specs.push(value);
    }
  }

  if (specs.length === 0) {
    throw new Error('Could not find OpenAPI object in legacy data bundle');
  }

  return specs;
}

async function fetchLegacyOpenApiSpecs() {
  // The dynamic endpoint currently serves only newer docs. The remaining
  // published contracts are still imported by the API-docs frontend bundle.
  const docsHtml = await fetchText(API_DOCS_URL);
  const entryScriptPath = docsHtml.match(/<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["'][^>]*>/i)?.[1];
  if (!entryScriptPath) {
    throw new Error('Could not find API docs application bundle');
  }

  const entryScript = await fetchText(new URL(entryScriptPath, API_DOCS_URL).toString());
  const mainScript = await fetchText(resolveBundleUrl(entryScript, 'main'));
  const apiDocsScript = await fetchText(resolveBundleUrl(mainScript, 'pages-api_docs'));
  const sourceUrl = resolveBundleUrl(apiDocsScript, 'openapi-data');
  const sourceCode = await fetchText(sourceUrl);
  return { sourceUrl, sourceCode, specs: extractOpenApiFromJs(sourceCode) };
}

async function fetchPersonalOpenApiSpec() {
  const html = await fetchText(PERSONAL_API_DOCS_URL);
  const stateJson = html.match(/const __redoc_state\s*=\s*({[\s\S]*?});\s*var container/)?.[1];

  if (!stateJson) {
    throw new Error(`Could not find __redoc_state in ${PERSONAL_API_DOCS_URL}`);
  }

  const spec = JSON.parse(stateJson)?.spec?.data;
  if (!spec?.openapi || !spec.paths || !spec.components) {
    throw new Error(`Could not find an OpenAPI spec in ${PERSONAL_API_DOCS_URL}`);
  }

  return { html, spec };
}

async function fetchPublishedSpecs() {
  // Monobank publishes Chast dynamically, most remaining specs in its frontend
  // bundle, and the personal API directly from its Redoc page.
  const [dynamic, legacy, personal] = await Promise.all([
    fetchOpenApiSpecs(),
    fetchLegacyOpenApiSpecs(),
    fetchPersonalOpenApiSpec(),
  ]);

  return {
    specs: [...legacy.specs, ...dynamic.specs, personal.spec],
    dynamicResponse: dynamic.response,
    legacySourceUrl: legacy.sourceUrl,
    legacySourceCode: legacy.sourceCode,
    personalDocsHtml: personal.html,
  };
}

module.exports = {
  API_DOCS_URL,
  OPENAPI_SPECS_URL,
  PERSONAL_API_DOCS_URL,
  fetchPublishedSpecs,
};
