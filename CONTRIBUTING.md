# Contributing to squad-on-aca

Thank you for your interest in contributing to **squad-on-aca**! We welcome bug reports, feature suggestions, documentation improvements, and pull requests.

## Reporting Bugs

1. **Search existing issues** at https://github.com/haflidif/squad-on-aca/issues to avoid duplicates
2. **Create a new issue** with the bug template and include:
   - Clear description of the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, tool versions, Azure region if relevant)
   - Error logs or stack traces if available
   - Screenshots if applicable

## Suggesting Features

1. **Search existing issues** to check if the feature has been requested
2. **Create a new issue** with the feature template and describe:
   - Problem the feature solves
   - Proposed solution
   - Alternative approaches considered
   - Use case or motivation

Feature requests are reviewed by maintainers for alignment with the project's scope and architecture.

## Submitting Pull Requests

### Prerequisites for Local Development

Install the following on your development machine:

- **Terraform** ≥ 1.5 ([install](https://learn.hashicorp.com/tutorials/terraform/install-cli))
- **Azure CLI** ≥ 2.50 ([install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli))
- **Docker** ([install](https://docs.docker.com/get-docker/))
- **Python** ≥ 3.11 ([install](https://www.python.org/downloads/))
- **GitHub CLI** (`gh`) ([install](https://cli.github.com/))

Verify installation:
```bash
terraform version
az --version
docker --version
python --version
gh --version
```

### Fork, Branch, and Submit

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/<your-username>/squad-on-aca.git
   cd squad-on-aca
   ```
3. **Create a feature branch:**
   ```bash
   git checkout -b fix/your-issue-name
   # or
   git checkout -b feature/your-feature-name
   ```
4. **Make your changes** (see Code Style below)
5. **Test your changes:**
   - For **Terraform**: Run `terraform fmt` and `terraform validate`
   - For **Python**: Run `black` and `ruff check`
   - For **Docker**: Build with `docker build` and verify entrypoint
6. **Commit with a clear message:**
   ```bash
   git commit -m "Brief description of changes"
   ```
7. **Push to your fork:**
   ```bash
   git push origin fix/your-issue-name
   ```
8. **Open a pull request** against the `main` branch:
   - Link the related issue (if any)
   - Describe what was changed and why
   - Note any testing performed
   - Call out any breaking changes

### Pull Request Guidelines

- Keep PRs focused and reasonably scoped
- Ensure CI passes (linting, builds, tests)
- Add or update tests if modifying core logic
- Update documentation if API or configuration changes
- One commit or logical series of commits (squash if appropriate)

## Code Style Expectations

### Terraform

All Terraform code must be formatted and validated:

```bash
# Format all .tf files
terraform fmt -recursive .

# Validate against HCL schema
terraform validate
```

Follow these conventions:
- Use `locals` blocks for computed values
- Use `var.*` only for input variables
- Document complex resources with inline comments
- Use descriptive variable and resource names (snake_case)
- Leverage Azure Verified Modules (AVM) for standard resources

### Python

All Python code must be formatted with `black` and linted with `ruff`:

```bash
# Format code
black function/

# Check for issues (no fixing mode)
ruff check function/
```

Follow these conventions:
- Use type hints (`def process_message(msg: dict) -> str:`)
- Prefer f-strings over `.format()`
- Keep functions under 50 lines where practical
- Document public functions with docstrings

### Docker & Shell Scripts

- Use `#!/bin/bash -e` for bash scripts (fail on error)
- Add comments for non-obvious logic
- Keep the agent image small (multi-stage builds preferred)

## About the `.squad/` Directory

The `.squad/` directory contains project governance and team agent configuration for the **Squad multi-agent framework** (https://github.com/github/github-copilot-cli). This is intentionally included as a showcase of how Squad coordinates AI agents for complex software delivery tasks.

**Contributors do not need to modify this directory** — it is used internally by the maintainer to coordinate agent work and preserve team decisions. The `.squad/` content is read-only for external contributors and documents the project's decision history and architecture.

## DCO / CLA

**No Developer Certificate of Origin (DCO) or Contributor License Agreement (CLA) is required** for this project. Your contributions are used under the terms of the MIT License. By submitting a PR, you agree that your work may be distributed under the MIT License.

## Code of Conduct

This project adheres to the **Contributor Covenant Code of Conduct** ([CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)). By participating, you agree to uphold this code.

## Questions?

If you have questions:
- Open a discussion in the GitHub repo
- Check the [docs/](./docs/) folder for architecture and adoption guidance
- Review existing issues and PRs for similar topics

Thank you for contributing! 🙏
