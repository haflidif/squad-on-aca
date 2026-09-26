const fs = require('node:fs');
const path = require('node:path');
const {
  findOverlappingOwnedPaths,
  isSubsetOfOwnedPaths,
  validateOwnedPathList
} = require('./path-scope');

const SCHEMA_DIR = path.join(__dirname, '..', 'schemas');
const SAFE_ARTIFACT_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu;

function artifactPathCollisionKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function validateArtifactPath(value, location) {
  const errors = [];
  if (typeof value !== 'string' || value.length === 0) return [`${location} must be a non-empty string`];
  if (value.includes('\0')) errors.push(`${location} must not contain NUL bytes`);
  if (/[\x00-\x1F\x7F]/u.test(value)) errors.push(`${location} must not contain control characters`);
  if (value.includes(':')) errors.push(`${location} must not contain colon characters`);
  if (value.includes('\\')) errors.push(`${location} must use POSIX separators`);
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) errors.push(`${location} must be a relative POSIX path`);
  if (!SAFE_ARTIFACT_PATH_PATTERN.test(value)) errors.push(`${location} contains unsupported characters or empty segments`);
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') errors.push(`${location} must not contain dot segments`);
    if (/[. ]$/u.test(segment)) errors.push(`${location} segments must not end in dot or space`);
    const baseName = segment.normalize('NFC').split('.')[0];
    if (WINDOWS_RESERVED_DEVICE_PATTERN.test(baseName)) errors.push(`${location} must not contain Windows reserved device names`);
  }
  return errors;
}

function validateArtifactPathCollisions(artifacts) {
  const errors = [];
  const seen = new Map();
  for (const [index, artifact] of (artifacts || []).entries()) {
    if (typeof artifact.path !== 'string') continue;
    const key = artifactPathCollisionKey(artifact.path);
    const existing = seen.get(key);
    if (existing) {
      errors.push(`artifacts[${index}].path collides with ${existing.location} after Unicode normalization and case folding`);
    } else {
      seen.set(key, { location: `artifacts[${index}].path`, path: artifact.path });
    }
  }
  return errors;
}

function loadSchemas() {
  const schemas = new Map();
  for (const file of fs.readdirSync(SCHEMA_DIR)) {
    if (file.endsWith('.schema.json')) {
      schemas.set(file, JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8')));
    }
  }
  return schemas;
}

function resolveRef(ref, rootSchema, schemas) {
  const [file, fragment] = ref.split('#');
  const base = file ? schemas.get(path.basename(file)) : rootSchema;
  if (!base) throw new Error(`Unknown schema reference: ${ref}`);
  if (!fragment) return base;
  return fragment.slice(1).split('/').reduce((value, part) => value[part.replace(/~1/g, '/').replace(/~0/g, '~')], base);
}

function validateAgainstSchema(value, schema, rootSchema, schemas, location = '$') {
  const errors = [];
  if (schema.$ref) {
    return validateAgainstSchema(value, resolveRef(schema.$ref, rootSchema, schemas), rootSchema, schemas, location);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.map(option => validateAgainstSchema(value, option, rootSchema, schemas, location))
      .filter(optionErrors => optionErrors.length === 0);
    return matches.length === 1
      ? []
      : [`${location} must match exactly one schema variant (matched ${matches.length})`];
  }
  if (schema.allOf) {
    const merged = {};
    for (const part of schema.allOf) {
      const resolved = part.$ref ? resolveRef(part.$ref, rootSchema, schemas) : part;
      Object.assign(merged, resolved);
      if (resolved.properties) merged.properties = { ...merged.properties, ...resolved.properties };
      if (resolved.required) merged.required = [...(merged.required || []), ...resolved.required];
    }
    if (merged.required) merged.required = [...new Set(merged.required)];
    return validateAgainstSchema(value, merged, rootSchema, schemas, location);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${location} must be an object`];
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${location}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!schema.properties || !(key in schema.properties)) errors.push(`${location}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateAgainstSchema(value[key], childSchema, rootSchema, schemas, `${location}.${key}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${location} must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const serialized = value.map(item => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${location} must contain unique items`);
    }
    for (let index = 0; index < value.length; index++) {
      errors.push(...validateAgainstSchema(value[index], schema.items, rootSchema, schemas, `${location}[${index}]`));
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${location} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} must not be empty`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${location} has an invalid format`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return [`${location} must be an integer`];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} must be at least ${schema.minimum}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location} must be one of ${schema.enum.join(', ')}`);
  return errors;
}

function semanticErrors(contractName, value, context) {
  const errors = [];
  if (contractName === 'coordinator-execution.schema.json') {
    if (value.issue && (
      (typeof value.issue.repo === 'string' && (value.issue.repo.includes('..') || value.issue.repo.endsWith('.git'))) ||
      !Number.isSafeInteger(value.issue.issue_number)
    )) errors.push('plan issue binding has an invalid repository or issue number');
    const ids = new Set(value.tasks.map(task => task.task_id));
    if (ids.size !== value.tasks.length) errors.push('task IDs must be unique');
    const rosterMembers = value.roster?.members || [];
    const rosterById = new Map(rosterMembers.map(member => [member.logical_member_id, member]));
    for (const task of value.tasks) {
      const rosterMember = rosterById.get(task.owner.logical_member_id);
      if (!rosterMember) {
        errors.push(`task ${task.task_id} owner is not present in roster snapshot`);
      } else {
        if (JSON.stringify(rosterMember) !== JSON.stringify(task.owner)) errors.push(`task ${task.task_id} owner identity does not match roster snapshot`);
        const capabilities = new Set(rosterMember.capabilities);
        for (const capability of task.required_capabilities) {
          if (!capabilities.has(capability)) errors.push(`task ${task.task_id} requires capability not held by owner: ${capability}`);
        }
      }
      if (task.baseline_sha !== value.baseline_sha) errors.push(`task ${task.task_id} baseline SHA does not match plan`);
      if (JSON.stringify(task.provider) !== JSON.stringify(value.provider)) errors.push(`task ${task.task_id} provider does not match plan`);
      errors.push(...validateOwnedPathList(task.owned_paths, `task ${task.task_id} owned_paths`));
      for (const dependency of task.dependencies) {
        if (dependency.task_id === task.task_id) errors.push(`task ${task.task_id} cannot depend on itself`);
        if (!ids.has(dependency.task_id)) errors.push(`task ${task.task_id} depends on unknown task ${dependency.task_id}`);
      }
    }
    errors.push(...findOverlappingOwnedPaths(value.tasks));
    const visiting = new Set();
    const visited = new Set();
    const tasksById = new Map(value.tasks.map(task => [task.task_id, task]));
    function visit(taskId) {
      if (!tasksById.has(taskId)) return;
      if (visiting.has(taskId)) {
        errors.push(`dependency cycle includes ${taskId}`);
        return;
      }
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of tasksById.get(taskId).dependencies) visit(dependency.task_id);
      visiting.delete(taskId);
      visited.add(taskId);
    }
    for (const task of value.tasks) visit(task.task_id);
  }
  if (['persona-dispatch.schema.json', 'persona-result.schema.json', 'artifact-manifest.schema.json', 'integration-result.schema.json', 'integration-dispatch.schema.json'].includes(contractName)) {
    if (context) {
      if (value.baseline_sha !== context.baseline_sha) errors.push('baseline SHA does not match execution plan');
      if (JSON.stringify(value.roster) !== JSON.stringify(context.roster)) errors.push('roster snapshot does not match execution plan');
      if (JSON.stringify(value.provider) !== JSON.stringify(context.provider)) errors.push('provider does not match execution plan');
    }
    if (value.owner) {
      const rosterMember = value.roster?.members?.find(member => member.logical_member_id === value.owner.logical_member_id);
      if (!rosterMember) errors.push('owner is not present in roster snapshot');
      else if (JSON.stringify(rosterMember) !== JSON.stringify(value.owner)) errors.push('owner identity does not match roster snapshot');
      if (value.required_capabilities) {
        for (const capability of value.required_capabilities) {
          if (!value.owner.capabilities.includes(capability)) errors.push(`required capability not held by owner: ${capability}`);
        }
      }
    }
    if (contractName === 'persona-dispatch.schema.json') {
      errors.push(...validateOwnedPathList(value.owned_paths, 'owned_paths'));
      if (context?.tasks) {
        const task = context.tasks.find(candidate => candidate.task_id === value.task_id);
        if (!task) {
          errors.push(`dispatch task ${value.task_id} is not present in execution plan`);
        } else {
          for (const ownedPath of value.owned_paths || []) {
            if (!isSubsetOfOwnedPaths(ownedPath, task.owned_paths || [])) {
              errors.push(`dispatch owned path ${ownedPath} is outside task ${task.task_id} owned_paths`);
            }
          }
        }
      }
    }
    if (contractName === 'integration-dispatch.schema.json') {
      const ids = new Set((value.tasks || []).map(task => task.task_id));
      if (ids.size !== (value.tasks || []).length) errors.push('integration task IDs must be unique');
      for (const task of value.tasks || []) {
        const rosterMember = value.roster?.members?.find(member => member.logical_member_id === task.owner.logical_member_id);
        if (!rosterMember) errors.push(`integration task ${task.task_id} owner is not present in roster snapshot`);
        else if (JSON.stringify(rosterMember) !== JSON.stringify(task.owner)) errors.push(`integration task ${task.task_id} owner identity does not match roster snapshot`);
        errors.push(...validateOwnedPathList(task.owned_paths || [], `integration task ${task.task_id} owned_paths`));
        for (const dependency of task.dependencies || []) {
          if (dependency.task_id === task.task_id) errors.push(`integration task ${task.task_id} cannot depend on itself`);
          if (!ids.has(dependency.task_id)) errors.push(`integration task ${task.task_id} depends on unknown task ${dependency.task_id}`);
        }
      }
      const visiting = new Set();
      const visited = new Set();
      const tasksById = new Map((value.tasks || []).map(task => [task.task_id, task]));
      function visitIntegration(taskId) {
        if (!tasksById.has(taskId)) return;
        if (visiting.has(taskId)) {
          errors.push(`integration dependency cycle includes ${taskId}`);
          return;
        }
        if (visited.has(taskId)) return;
        visiting.add(taskId);
        for (const dependency of tasksById.get(taskId).dependencies || []) visitIntegration(dependency.task_id);
        visiting.delete(taskId);
        visited.add(taskId);
      }
      for (const task of value.tasks || []) visitIntegration(task.task_id);
    }
    if (contractName === 'artifact-manifest.schema.json') {
      for (const [index, artifact] of (value.artifacts || []).entries()) {
        errors.push(...validateArtifactPath(artifact.path, `artifacts[${index}].path`));
      }
      errors.push(...validateArtifactPathCollisions(value.artifacts));
    }
  }
  return errors;
}

function validateContract(contractName, value, context) {
  const schemas = loadSchemas();
  const schema = schemas.get(contractName);
  if (!schema) throw new Error(`Unknown contract schema: ${contractName}`);
  const errors = [
    ...validateAgainstSchema(value, schema, schema, schemas),
    ...semanticErrors(contractName, value, context)
  ];
  return { valid: errors.length === 0, errors };
}

module.exports = { validateContract };

if (require.main === module) {
  const [contractName, fixturePath] = process.argv.slice(2);
  if (!contractName || !fixturePath) {
    console.error('Usage: node validate.js <schema-file> <fixture-file>');
    process.exitCode = 2;
  } else {
    const result = validateContract(contractName, JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    if (!result.valid) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`valid: ${contractName}`);
    }
  }
}
