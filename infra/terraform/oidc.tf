variable "oidc_subjects" {
  description = "Exact GitHub OIDC subjects keyed by target repository, then jobs or sandbox. Omitted bindings retain the name-based default. Include repo plus ref/environment; customized numeric ID claims must be paired."
  type        = map(map(string))
  default     = {}
  nullable    = false

  validation {
    condition = alltrue([for repo, subjects in var.oidc_subjects :
      contains(var.target_repos, repo) && length(subjects) > 0 && alltrue([for backend, subject in subjects : contains(["jobs", "sandbox"], backend) && subject != null])
    ])
    error_message = "oidc_subjects must reference target_repos and contain only non-null jobs/sandbox subject overrides."
  }
}

locals {
  oidc_subjects = {
    for backend, context in { jobs = "ref:refs/heads/main", sandbox = "environment:squad-sandbox-issue" } : backend => {
      for repo in distinct(var.target_repos) : repo => lookup(lookup(var.oidc_subjects, repo, {}), backend, "repo:${repo}:${context}")
    }
  }
  oidc_records = flatten([for backend, subjects in local.oidc_subjects : [for repo, subject in subjects : {
    backend = backend
    repo    = repo
    parts   = split(":", coalesce(subject, "invalid"))
  }]])
  oidc_claims = [for record in local.oidc_records : merge(record, {
    claims = [for index in range(0, length(record.parts), 2) : {
      key   = record.parts[index]
      value = try(record.parts[index + 1], "")
    }]
  })]
  oidc_valid = alltrue([for record in local.oidc_claims :
    contains([4, 8], length(record.parts)) &&
    length(distinct([for claim in record.claims : claim.key])) == length(record.claims) &&
    length([for claim in record.claims : claim if claim.key == "repo"]) == 1 &&
    length([for claim in record.claims : claim if contains(["ref", "environment"], claim.key)]) == 1 &&
    alltrue([for claim in record.claims : (
      claim.key == "repo" ? can(regex("^(${replace(record.repo, ".", "\\.")}|${replace(split("/", record.repo)[0], ".", "\\.")}@[1-9][0-9]*/${replace(split("/", record.repo)[1], ".", "\\.")}@[1-9][0-9]*)$", claim.value)) :
      claim.key == "ref" ? record.backend == "jobs" && claim.value == "refs/heads/main" :
      claim.key == "environment" ? record.backend == "sandbox" && claim.value == "squad-sandbox-issue" :
      contains(["repository_owner_id", "repository_id"], claim.key) ? can(regex("^[1-9][0-9]*$", claim.value)) : false
    )]) &&
    alltrue([for claim in record.claims : !contains(["repository_owner_id", "repository_id"], claim.key) || alltrue([
      for repository in record.claims : length(regexall("@", repository.value)) == 0 || try(
        regexall("@([1-9][0-9]*)", repository.value)[claim.key == "repository_owner_id" ? 0 : 1][0] == claim.value, false
      ) if repository.key == "repo"
    ])])
  ])
}
