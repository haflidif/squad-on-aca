variable "subscription_id" {
  type        = string
  description = "Approved lab subscription."
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

variable "storage_account_name" {
  type        = string
  default     = null
  description = "Optional globally unique state account name; check availability before apply."
  validation {
    condition     = var.storage_account_name == null || can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "Storage account name must be 3-24 lowercase alphanumeric characters."
  }
}

variable "operator_ipv4_cidrs" {
  type        = list(string)
  description = "Explicit IPv4 public egress CIDRs permitted to reach the state endpoint."
  validation {
    condition     = length(var.operator_ipv4_cidrs) > 0 && alltrue([for cidr in var.operator_ipv4_cidrs : can(cidrhost(cidr, 0)) && !strcontains(cidr, ":")])
    error_message = "Provide at least one valid operator IPv4 CIDR."
  }
}

variable "state_operator_principal_id" {
  type        = string
  default     = null
  description = "Optional Entra object ID for blob data RBAC; null creates no assignment. Bootstrap operator must already have blob data rights to create the container."
  validation {
    condition     = var.state_operator_principal_id == null || can(regex("^[0-9a-fA-F-]{36}$", var.state_operator_principal_id))
    error_message = "Provide a principal GUID or null."
  }
}

variable "network_default_action" {
  type        = string
  default     = "Deny"
  description = "Storage firewall default action. Use Allow only when operator egress is tunneled (for example Global Secure Access) and the account carries the approved policy exemption tag."
  validation {
    condition     = contains(["Allow", "Deny"], var.network_default_action)
    error_message = "network_default_action must be Allow or Deny."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
