variable "subscription_id" {
  type = string
  validation {
    condition     = var.subscription_id == "e69b8a95-fe38-42da-b5e6-e3e0a833cf9e"
    error_message = "Use the approved sandbox lab subscription."
  }
}

variable "resource_group_name" {
  type    = string
  default = "rg-squad-aca-sandbox-lab"
  validation {
    condition     = var.resource_group_name == "rg-squad-aca-sandbox-lab"
    error_message = "Use the approved lab resource group."
  }
}

variable "location" {
  type    = string
  default = "swedencentral"
  validation {
    condition     = var.location == "swedencentral"
    error_message = "Use the approved lab location."
  }
}

variable "acr_name" {
  type    = string
  default = "crsquadacaa6b49feb"
  validation {
    condition     = var.acr_name == "crsquadacaa6b49feb"
    error_message = "Only the approved existing ACR is in scope."
  }
}

variable "acr_resource_group_name" {
  type    = string
  default = "rg-squad-aca-dev-a6b49feb"
  validation {
    condition     = var.acr_resource_group_name == "rg-squad-aca-dev-a6b49feb"
    error_message = "Only the approved existing ACR resource group is in scope."
  }
}

variable "sandbox_group_name" {
  type    = string
  default = "sbg-squad-aca-sandbox-lab"
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
