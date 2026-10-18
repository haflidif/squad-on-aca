variable "execution_backend" {
  description = "Execution backend for this deployment. Use a separate destination when switching an existing install."
  type        = string
  default     = "jobs"
  nullable    = false

  validation {
    condition     = contains(["jobs", "sandbox"], var.execution_backend)
    error_message = "execution_backend must be jobs or sandbox."
  }
}

variable "release_version" {
  description = "Installed platform release recorded in the descriptor."
  type        = string
  default     = "0.0.1"
  validation {
    condition     = length(trimspace(var.release_version)) > 0
    error_message = "release_version must not be empty."
  }
}

variable "jobs_image_ref" {
  description = "Optional immutable Jobs image. Empty preserves the existing latest image and withholds the onboarding descriptor."
  type        = string
  default     = ""
  validation {
    condition     = var.jobs_image_ref == "" || can(regex("^[^\\s@]+@sha256:[0-9a-f]{64}$", var.jobs_image_ref))
    error_message = "jobs_image_ref must be empty or pinned to a lowercase SHA-256 digest."
  }
}

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "swedencentral"
}

variable "enable_aca_sandbox" {
  description = "Legacy additive Jobs plus Sandbox mode. Preserved for existing mixed installs, not compatible with execution_backend=sandbox."
  type        = bool
  default     = false
}

variable "squad_issue_opt_in_number" {
  description = "The one issue number allowed by the opt-in ACA Sandbox issue workflow. Use 0 to keep issue-level dispatch closed."
  type        = string
  default     = "0"

  validation {
    condition     = can(regex("^[0-9]+$", var.squad_issue_opt_in_number))
    error_message = "squad_issue_opt_in_number must contain only decimal digits."
  }
}

variable "sandbox_image_ref" {
  description = "Immutable worker image required by Sandbox selection; optional for legacy additive inventory. Must include a SHA-256 digest."
  type        = string
  default     = ""

  validation {
    condition     = var.sandbox_image_ref == "" || can(regex("^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$", var.sandbox_image_ref))
    error_message = "sandbox_image_ref must be empty or an image reference pinned by a 64-character SHA-256 digest."
  }
}

variable "sandbox_group_location" {
  description = "Azure region for the ACA Sandbox Group. Null uses the main location."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.sandbox_group_location == null || length(trimspace(var.sandbox_group_location)) > 0
    error_message = "sandbox_group_location must be null or a non-empty Azure region name."
  }
}

variable "sandbox_default_cpu" {
  description = "Default CPU passed by the dispatcher when creating each ACA sandbox."
  type        = string
  default     = "1000m"

  validation {
    condition     = can(regex("^[0-9]+m$", var.sandbox_default_cpu))
    error_message = "sandbox_default_cpu must be expressed in millicores, e.g. 1000m."
  }
}

variable "sandbox_default_memory" {
  description = "Default memory passed by the dispatcher when creating each ACA sandbox."
  type        = string
  default     = "2048Mi"

  validation {
    condition     = can(regex("^[0-9]+Mi$", var.sandbox_default_memory))
    error_message = "sandbox_default_memory must be expressed in Mi, e.g. 2048Mi."
  }
}

variable "sandbox_default_auto_suspend_seconds" {
  description = "Default auto-suspend duration in seconds passed by the dispatcher when creating each ACA sandbox."
  type        = number
  default     = 300

  validation {
    condition     = var.sandbox_default_auto_suspend_seconds > 0
    error_message = "sandbox_default_auto_suspend_seconds must be greater than 0."
  }
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "squad-aca"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "github_repo" {
  description = "GitHub repository in owner/repo format"
  type        = string
  default     = "haflidif/squad-on-aca"
}

variable "github_token" {
  description = "GitHub PAT used by Terraform GitHub provider for managing Actions variables"
  type        = string
  sensitive   = true
}

variable "queue_name" {
  description = "Name of the Storage Queue for squad work items"
  type        = string
  default     = "squad-work-queue"
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    project    = "squad-on-aca"
    managed_by = "terraform"
  }
}

variable "target_repos" {
  description = "GitHub repositories (owner/repo format) allowed to authenticate via OIDC federated credentials"
  type        = list(string)
  default     = []
}

variable "github_app_id" {
  default     = ""
  description = "GitHub App ID (numeric)"
  type        = string
}

variable "github_app_installation_id" {
  default     = ""
  description = "GitHub App Installation ID"
  type        = string
}


variable "agent_job_config" {
  description = "Configuration for the generic squad agent Container App Job"
  type = object({
    cpu             = optional(number, 1.0)
    memory          = optional(string, "2Gi")
    max_executions  = optional(number, 10)
    timeout_seconds = optional(number, 1800)
  })
  default = {}

  validation {
    condition     = var.agent_job_config.timeout_seconds >= 1 && floor(var.agent_job_config.timeout_seconds) == var.agent_job_config.timeout_seconds
    error_message = "timeout_seconds must be a positive integer."
  }

  validation {
    condition     = contains([0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0], var.agent_job_config.cpu)
    error_message = "CPU must be one of: 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0"
  }

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?Gi$", var.agent_job_config.memory))
    error_message = "Memory must be in the format '<number>Gi', e.g. '2Gi'."
  }

  validation {
    condition     = var.agent_job_config.max_executions >= 1 && var.agent_job_config.max_executions <= 30 && floor(var.agent_job_config.max_executions) == var.agent_job_config.max_executions
    error_message = "max_executions must be between 1 and 30."
  }
}
