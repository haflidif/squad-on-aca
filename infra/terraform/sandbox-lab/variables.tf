variable "subscription_id" {
  type        = string
  description = "Azure subscription GUID used for this deployment."
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "subscription_id must be a GUID."
  }
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type = string
}

variable "acr_name" {
  type = string
}

variable "acr_resource_group_name" {
  type = string
}

variable "sandbox_group_name" {
  type = string
}

variable "dispatcher_identity_name" {
  type    = string
  default = "id-squad-aca-sandbox-dispatch"
}

variable "image_pull_identity_name" {
  type    = string
  default = "id-squad-aca-sandbox-acrpull"
}

variable "grant_group_acr_pull" {
  type        = bool
  default     = false
  description = "Grant AcrPull on the approved ACR to the image-pull UAMI attached to the Sandbox Group. The v2 disk-image request selects it through source.managedIdentityClientId. Registry-wide scope; enable only with approval."
}

variable "operator_principal_id" {
  type        = string
  default     = null
  description = "Optional Entra object ID granted group-scoped SandboxGroup Data Owner for operator probes; null creates no assignment."
  validation {
    condition     = var.operator_principal_id == null || can(regex("^[0-9a-fA-F-]{36}$", var.operator_principal_id))
    error_message = "Provide a principal GUID or null."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "repository_full_name" {
  type        = string
  description = "Owner/repository that receives the Sandbox environment OIDC credential."
  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.repository_full_name))
    error_message = "repository_full_name must use owner/repository format."
  }
}

variable "environment_name" {
  type        = string
  description = "GitHub environment name used by the Sandbox workflow OIDC subject."
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.environment_name))
    error_message = "environment_name may contain letters, numbers, hyphens and underscores."
  }
}
