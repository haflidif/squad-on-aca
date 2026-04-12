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
