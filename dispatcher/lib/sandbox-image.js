const IMAGE_PATTERN = /^crsquadacaa6b49feb\.azurecr\.io\/squad-sandbox-lab\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;

function validateSandboxImageRef(value) {
  if (typeof value !== 'string' || !IMAGE_PATTERN.test(value)) {
    throw new Error('SQUAD_SANDBOX_IMAGE_REF must be an immutable sha256 digest in crsquadacaa6b49feb.azurecr.io/squad-sandbox-lab/ (no tag or credentials).');
  }
  return value;
}

module.exports = { validateSandboxImageRef };
