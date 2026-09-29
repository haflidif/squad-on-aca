#!/usr/bin/env node
'use strict';

// Validates the NPM_REGISTRY build arg before npm sees it. Dependency-free so
// it can run in the Docker build stage. Never prints the candidate value.

const MAX_LENGTH = 2048;

function validateNpmRegistry(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'NPM_REGISTRY is empty' };
  }
  if (value.length > MAX_LENGTH) {
    return { ok: false, reason: 'NPM_REGISTRY is too long' };
  }
  // Reject whitespace, control characters and backslashes before parsing,
  // because the WHATWG parser silently strips or rewrites them.
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/.test(value)) {
    return { ok: false, reason: 'NPM_REGISTRY contains invalid characters' };
  }
  if (!/^https:\/\/[^/]/i.test(value)) {
    return { ok: false, reason: 'NPM_REGISTRY must be an https:// URL' };
  }
  if (value.includes('@')) {
    return { ok: false, reason: 'NPM_REGISTRY must not contain credentials' };
  }
  if (value.includes('?')) {
    return { ok: false, reason: 'NPM_REGISTRY must not contain a query string' };
  }
  if (value.includes('#')) {
    return { ok: false, reason: 'NPM_REGISTRY must not contain a fragment' };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'NPM_REGISTRY is not a valid URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'NPM_REGISTRY must be an https:// URL' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'NPM_REGISTRY must not contain credentials' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'NPM_REGISTRY must not contain a query string or fragment' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'NPM_REGISTRY is not a valid URL' };
  }
  return { ok: true };
}

module.exports = { validateNpmRegistry };

if (require.main === module) {
  const result = validateNpmRegistry(process.env.NPM_REGISTRY);
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
}
