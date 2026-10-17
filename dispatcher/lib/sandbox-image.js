const IMAGE_PATTERN = /^(?=.{1,255}$)[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;

function validateSandboxImageRef(value) {
  if (typeof value !== 'string' || !IMAGE_PATTERN.test(value)) {
    throw new Error('SQUAD_SANDBOX_IMAGE_REF must be an immutable sha256 digest reference without a tag or credentials.');
  }
  return value;
}

module.exports = { validateSandboxImageRef };
