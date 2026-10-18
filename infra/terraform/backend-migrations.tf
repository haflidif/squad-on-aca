# Preserve singleton addresses when adopting the default Jobs selector.
moved {
  from = module.storage
  to   = module.storage[0]
}

moved {
  from = module.aca_environment
  to   = module.aca_environment[0]
}

moved {
  from = azurerm_user_assigned_identity.squad_agent
  to   = azurerm_user_assigned_identity.squad_agent[0]
}

moved {
  from = azurerm_role_assignment.agent_queue_reader
  to   = azurerm_role_assignment.agent_queue_reader[0]
}

moved {
  from = azurerm_role_assignment.agent_queue_contributor
  to   = azurerm_role_assignment.agent_queue_contributor[0]
}

moved {
  from = azurerm_role_assignment.agent_acr_pull
  to   = azurerm_role_assignment.agent_acr_pull[0]
}

moved {
  from = azurerm_role_assignment.agent_acr_push
  to   = azurerm_role_assignment.agent_acr_push[0]
}

moved {
  from = azurerm_key_vault.squad
  to   = azurerm_key_vault.squad[0]
}

moved {
  from = azurerm_role_assignment.agent_keyvault_reader
  to   = azurerm_role_assignment.agent_keyvault_reader[0]
}

moved {
  from = azurerm_role_assignment.deployer_keyvault_officer
  to   = azurerm_role_assignment.deployer_keyvault_officer[0]
}

moved {
  from = azapi_resource.squad_agent_job
  to   = azapi_resource.squad_agent_job[0]
}
