variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "swedencentral"
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
  description = "GitHub PAT with repo scope for issue polling"
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
  description = "GitHub App ID (numeric)"
  type        = string
}

variable "github_app_installation_id" {
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
    condition     = contains([0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0], var.agent_job_config.cpu)
    error_message = "CPU must be one of: 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0"
  }

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?Gi$", var.agent_job_config.memory))
    error_message = "Memory must be in the format '<number>Gi', e.g. '2Gi'."
  }

  validation {
    condition     = var.agent_job_config.max_executions >= 1 && var.agent_job_config.max_executions <= 30
    error_message = "max_executions must be between 1 and 30."
  }
}
