#!/usr/bin/env bash
if [[ "${SQUAD_RUNTIME_REPO_SH:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi
SQUAD_RUNTIME_REPO_SH=1

configure_git_identity() {
  git config --global user.name "squad-aca-bot[bot]"
  git config --global user.email "3362344+squad-aca-bot[bot]@users.noreply.github.com"
}

clone_repository() {
  local repo="$1"
  local destination="$2"
  gh repo clone "${repo}" "${destination}" || die "Failed to clone ${repo}."
}

checkout_branch() {
  local branch="$1"
  git checkout "${branch}" || die "Failed to checkout branch ${branch}."
}

create_branch() {
  local branch="$1"
  git checkout -b "${branch}"
}
