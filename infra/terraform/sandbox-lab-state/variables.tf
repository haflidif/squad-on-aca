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
    condition     = (var.network_default_action == "Allow" || length(var.operator_ipv4_cidrs) > 0) && alltrue([for cidr in var.operator_ipv4_cidrs : can(cidrhost(cidr, 0)) && !strcontains(cidr, ":")])
    error_message = "Provide valid operator IPv4 CIDRs when network_default_action is Deny."
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
