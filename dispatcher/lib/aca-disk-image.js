const DEFAULT_ENDPOINT = 'https://management.swedencentral.azuredevcompute.io';
const TOKEN_AUDIENCE = 'https://management.azuredevcompute.io';
const API_VERSION = '2026-02-01-preview';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const { validateSandboxImageRef } = require('./sandbox-image');

function validSegment(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,90}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} must be a valid resource name.`);
  }
  return value;
}

function parseOperationLocation(value, endpoint, subscriptionId, resourceGroup, groupName) {
  if (typeof value !== 'string' || !value) throw new Error('ACA disk image response is missing operation-location.');
  let url;
  try {
    url = new URL(value, endpoint);
  } catch {
    throw new Error('ACA disk image operation-location is malformed.');
  }
  const expected = new URL(endpoint);
  const path = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/sandboxGroups/${groupName}/diskimages/operations/`;
  const queryEntries = [...url.searchParams.entries()];
  const allowedQuery = queryEntries.length === 0 ||
    (queryEntries.length === 1 && queryEntries[0][0] === 'api-version' && queryEntries[0][1] === API_VERSION);
  if (url.origin !== expected.origin || url.username || url.password ||
      !new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9-]+$`).test(url.pathname) ||
      !allowedQuery || url.hash) {
    throw new Error('ACA disk image operation-location is outside the expected endpoint.');
  }
  return url.toString();
}

async function fetchWithin(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectAbort(new Error('request timed out'));
  }, timeoutMs);
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      aborted
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createDiskImage(options) {
  const {
    imageUrl, managedIdentityClientId, subscriptionId, resourceGroup, groupName,
    name, getToken, fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT,
    timeoutMs = 180000, requestTimeoutMs = 30000, pollIntervalMs = 2000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = options;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for ACA disk image creation.');
  if (typeof getToken !== 'function') throw new Error('Azure token provider is required for ACA disk image creation.');
  for (const [value, label] of [[subscriptionId, 'subscription ID'], [resourceGroup, 'resource group'], [groupName, 'sandbox group'], [name, 'disk image name']]) {
    validSegment(value, label);
  }
  if (!UUID_PATTERN.test(subscriptionId)) throw new Error('Azure subscription ID must be a valid UUID.');
  if (typeof managedIdentityClientId !== 'string' || !UUID_PATTERN.test(managedIdentityClientId)) {
    throw new Error('SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID must be a valid managed identity client ID.');
  }
  validateSandboxImageRef(imageUrl);
  if (typeof endpoint !== 'string' || endpoint !== DEFAULT_ENDPOINT) throw new Error('ACA disk image endpoint is not approved.');

  const token = await getToken(TOKEN_AUDIENCE);
  if (typeof token !== 'string' || token.length < 20 || /[\r\n]/.test(token)) {
    throw new Error('Azure token provider returned an invalid token.');
  }
  const base = new URL(endpoint);
  const createUrl = new URL(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/sandboxGroups/${groupName}/diskimages/v2/async?api-version=${API_VERSION}`, base);
  let response;
  try {
    response = await fetchWithin(fetchImpl, createUrl, {
      method: 'PUT',
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        labels: { name },
        source: { kind: 'registry', imageUrl, managedIdentityClientId }
      })
    }, requestTimeoutMs);
  } catch (error) {
    throw new Error(error.message === 'request timed out'
      ? 'ACA disk image create request timed out.'
      : 'ACA disk image create request failed.');
  }
  if (!response || response.status !== 202) throw new Error(`ACA disk image create returned unexpected HTTP status ${response?.status ?? 'unknown'}.`);
  const operationUrl = parseOperationLocation(
    response.headers?.get?.('operation-location'),
    base.toString(),
    subscriptionId,
    resourceGroup,
    groupName
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    let operation;
    try {
      operation = await fetchWithin(fetchImpl, operationUrl, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}` }
      }, Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())));
    } catch (error) {
      throw new Error(error.message === 'request timed out'
        ? 'ACA disk image operation polling request timed out.'
        : 'ACA disk image operation polling request failed.');
    }
    if (!operation || ![200, 202].includes(operation.status)) {
      throw new Error(`ACA disk image operation returned unexpected HTTP status ${operation?.status ?? 'unknown'}.`);
    }
    let result;
    try {
      result = await operation.json();
    } catch {
      throw new Error('ACA disk image operation returned malformed JSON.');
    }
    if (!result || typeof result.status !== 'string') throw new Error('ACA disk image operation response is malformed.');
    if (result.status.toLowerCase() === 'succeeded') {
      const id = result.diskImage?.id;
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new Error('ACA disk image operation succeeded without a valid diskImage.id.');
      return id;
    }
    if (['failed', 'canceled', 'cancelled'].includes(result.status.toLowerCase())) {
      throw new Error('ACA disk image operation failed.');
    }
    if (!['accepted', 'running', 'inprogress', 'in_progress'].includes(result.status.toLowerCase())) {
      throw new Error('ACA disk image operation returned an unknown status.');
    }
  }
  throw new Error(`ACA disk image operation timed out after ${timeoutMs} ms.`);
}

module.exports = { createDiskImage, DEFAULT_ENDPOINT, TOKEN_AUDIENCE };
