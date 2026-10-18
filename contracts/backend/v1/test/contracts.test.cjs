const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const execution = read('schemas/execution.schema.json');
const descriptor = read('schemas/platform-descriptor.schema.json');
const installation = read('schemas/installation.schema.json');

// Only the JSON Schema keywords used by this contract are supported. Fail on new ones.
const keywords = new Set([
  '$schema', 'title', 'type', 'properties', 'additionalProperties', 'required',
  'const', 'enum', 'default', 'oneOf', 'pattern', 'minLength', 'minimum',
  'items', 'minItems', 'uniqueItems'
]);
function checkSchema(schema) {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) assert.ok(keywords.has(key), `Unsupported keyword: ${key}`);
  for (const child of Object.values(schema.properties || {})) checkSchema(child);
  for (const child of schema.oneOf || []) checkSchema(child);
  if (schema.items) checkSchema(schema.items);
}
function errors(value, schema, location = '$') {
  if (schema === false) return [`${location} is not allowed`];
  if (schema === true) return [];
  const result = [];
  if (schema.type) {
    const matches = schema.type === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value)
        : schema.type === 'integer' ? Number.isInteger(value) : typeof value === schema.type;
    if (!matches) return [`${location} must be ${schema.type}`];
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) result.push(`${location} has wrong constant`);
  if (schema.enum && !schema.enum.includes(value)) result.push(`${location} has invalid enum value`);
  if (schema.oneOf && schema.oneOf.filter(option => errors(value, option).length === 0).length !== 1) {
    result.push(`${location} must match exactly one variant`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) result.push(`${location}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) {
        result.push(...errors(child, schema.properties[key], `${location}.${key}`));
      } else if (schema.additionalProperties === false) result.push(`${location}.${key} is unknown`);
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) result.push(`${location} is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) result.push(`${location} has invalid format`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) result.push(`${location} is too small`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) result.push(`${location} has too few items`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) result.push(`${location} has duplicates`);
    if (schema.items) value.forEach((item, index) => result.push(...errors(item, schema.items, `${location}[${index}]`)));
  }
  return result;
}
function valid(value, schema) {
  assert.deepEqual(errors(value, schema), []);
}
function invalid(value, schema) {
  assert.notDeepEqual(errors(value, schema), []);
}

test('schemas use only the supported validation subset', () => {
  [execution, descriptor, installation].forEach(checkSchema);
});

for (const [name, expectedBackend, expectedProvider] of [
  ['jobs', 'jobs', 'aca-job'], ['sandbox', 'sandbox', 'aca-sandbox'], ['default', 'jobs', 'aca-job']
]) {
  test(`routing contract fixture: ${name}`, () => {
    const fixture = read(`fixtures/route-${name}.json`);
    valid(fixture, execution);
    const backend = fixture.backend ?? execution.properties.backend.default;
    assert.equal(backend, expectedBackend);
    assert.equal({ jobs: 'aca-job', sandbox: 'aca-sandbox' }[backend], expectedProvider);
  });
}

test('invalid routing fixture and unsupported selectors fail, not default to Jobs', () => {
  const fixture = read('fixtures/route-invalid.json');
  invalid(fixture, execution);
  for (const backend of ['', 'both', 'JOBS', null, 0, false, 'aca-job']) {
    invalid({ ...fixture, backend }, execution);
  }
  invalid({ ...fixture, backend: 'jobs', token: 'not-a-secret' }, execution);
  invalid({ schema_version: 'backend/v1' }, execution);
  invalid({ ...fixture, backend: 'jobs', enabled: 'true' }, execution);
  valid({ schema_version: 'backend/v1', platform_id: fixture.platform_id }, execution);
  assert.equal(execution.properties.enabled.default, false);
});

function exampleDescriptor(backend) {
  const platform = read('fixtures/route-jobs.json').platform_id;
  const id = type => `${platform}/providers/${type}/example`;
  const client = '00000000-0000-0000-0000-000000000000';
  const image = `example.azurecr.io/worker@sha256:${'a'.repeat(64)}`;
  return {
    schema_version: 'backend/v1', release_version: 'v1.0.0', platform_id: platform,
    backend, location: 'example-region', tenant_id: client,
    registry_id: id('Microsoft.ContainerRegistry/registries'),
    monitoring_id: id('Microsoft.OperationalInsights/workspaces'),
    limits: { max_concurrency: 2, timeout_seconds: 1800 },
    oidc: [{ client_id: client, subject: 'repo:example/repository:environment:squad-execution', audience: 'api://AzureADTokenExchange' }],
    protected_environments: ['squad-execution', 'squad-publish'],
    ...(backend === 'jobs' ? { jobs: {
      managed_environment_id: id('Microsoft.App/managedEnvironments'), job_id: id('Microsoft.App/jobs'),
      storage_account_id: id('Microsoft.Storage/storageAccounts'), queue_name: 'example-work',
      identity_client_id: client, image_ref: image, key_vault_id: id('Microsoft.KeyVault/vaults')
    } } : { sandbox: {
      group_id: id('Microsoft.App/sandboxGroups'), dispatcher_client_id: client,
      image_pull_client_id: client, image_ref: image
    } })
  };
}

for (const backend of ['jobs', 'sandbox']) {
  test(`descriptor includes exactly the selected ${backend} resource set`, () => {
    const value = exampleDescriptor(backend);
    valid(value, descriptor);
    const missing = structuredClone(value);
    delete missing[backend];
    invalid(missing, descriptor);
    invalid({ ...value, backend: backend === 'jobs' ? 'sandbox' : 'jobs' }, descriptor);
    invalid({ ...value, ...exampleDescriptor(backend === 'jobs' ? 'sandbox' : 'jobs') }, descriptor);
    invalid({ ...value, limits: { max_concurrency: 0, timeout_seconds: 1 } }, descriptor);
    invalid({ ...value, app_private_key: 'not-a-secret' }, descriptor);
    value[backend].image_ref = 'example.azurecr.io/worker:latest';
    invalid(value, descriptor);
  });
}

test('installation receipt records immutable source and generated file ownership', () => {
  const value = {
    schema_version: 'backend/v1', platform_id: read('fixtures/route-jobs.json').platform_id,
    release_version: 'v1.0.0', action_sha: 'a'.repeat(40),
    generated_files: [{ path: '.github/workflows/squad-aca.yml', sha256: 'b'.repeat(64) }]
  };
  valid(value, installation);
  const { platform_id, ...beforeDeployment } = value;
  for (const backend of ['jobs', 'sandbox']) valid({ ...beforeDeployment, backend }, installation);
  invalid({ ...beforeDeployment, backend: 'both' }, installation);
  invalid({ ...value, action_sha: 'main' }, installation);
  invalid({ ...value, generated_files: [] }, installation);
  invalid({ ...value, generated_files: [{ path: '.squad/execution.json', sha256: 'bad' }] }, installation);
  for (const file of ['/absolute', '../escape', 'dir/../escape', 'C:\\absolute', 'dir\\file']) {
    invalid({ ...value, generated_files: [{ path: file, sha256: 'b'.repeat(64) }] }, installation);
  }
});
