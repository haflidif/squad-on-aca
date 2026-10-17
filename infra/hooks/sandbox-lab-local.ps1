[CmdletBinding()]
param(
  [switch]$PreflightOnly,
  [string]$PlanPath,
  [string]$RepoPath = (Join-Path $PSScriptRoot '..\..'),
  [string]$Repository,
  [string]$IssueNumber,
  [string]$ImageRef,
  [string]$OutDir,
  [double]$Concurrency = 1,
  [double]$TimeoutMs = 300000,
  [switch]$AllowUnverifiedClient,
  [string]$AzureConfigDir = (Join-Path $env:USERPROFILE '.squad-sandbox-lab\azcfg'),
  [string]$AcaBin = (Join-Path $env:USERPROFILE '.aca\bin\aca.exe'),
  [string]$SubscriptionId = $env:SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID,
  [string]$TenantId = $env:SQUAD_SANDBOX_AZURE_TENANT_ID,
  [string]$Region = $env:SQUAD_SANDBOX_REGION,
  [string]$ResourceGroup = $env:SQUAD_SANDBOX_RESOURCE_GROUP_NAME,
  [string]$SandboxGroup = $env:SQUAD_SANDBOX_GROUP_NAME,
  [string]$ImagePullClientId = $env:SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID,
  [string]$ImagePullIdentityName = $env:SQUAD_SANDBOX_IMAGE_PULL_IDENTITY_NAME
)

# For local lab runs, omitted values can be loaded from the ignored infra/hooks/sandbox-lab.local.json file.
$localConfigPath = Join-Path $PSScriptRoot 'sandbox-lab.local.json'
if (Test-Path -LiteralPath $localConfigPath -PathType Leaf) {
  $localConfig = Get-Content -LiteralPath $localConfigPath -Raw | ConvertFrom-Json
  foreach ($name in @('SubscriptionId','TenantId','Region','ResourceGroup','SandboxGroup','ImagePullClientId','ImagePullIdentityName')) {
    if (-not (Get-Variable -Name $name -ValueOnly) -and $localConfig.$name) { Set-Variable -Name $name -Value $localConfig.$name -Scope Script }
  }
}

function Invoke-LabRead {
  param([string]$File, [string[]]$Arguments)
  $output = & $File @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Read/check failed: $([IO.Path]::GetFileName($File)). No automatic login or repair attempted." }
  return ($output -join "`n")
}

function Set-LabProcessEnvironment {
  param([string]$Name, [AllowNull()][object]$Value)
  if ($null -eq $Value) { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable($Name, [string]$Value, 'Process') }
}

function Invoke-SandboxLabLocal {
  param([hashtable]$Options)
  $ErrorActionPreference = 'Stop'
  if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'Use PowerShell 7.3 or newer for safe native JSON argument handling.' }
  foreach ($key in @('SubscriptionId','TenantId','Region','ResourceGroup','SandboxGroup','ImagePullClientId','ImagePullIdentityName')) {
    if (-not $Options[$key]) { throw "Missing required Sandbox configuration: $key. Supply a parameter, environment variable or ignored local config." }
  }
  foreach ($key in @('SubscriptionId','TenantId','ImagePullClientId')) {
    if ($Options[$key] -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw "$key must be a GUID." }
  }
  if ($Options.Concurrency -ne 1 -or $Options.TimeoutMs -lt 1000 -or $Options.TimeoutMs -gt 300000 -or
      [math]::Truncate($Options.TimeoutMs) -ne $Options.TimeoutMs) {
    throw 'Concurrency must be 1; TimeoutMs must be between 1000 and 300000.'
  }
  $config = [IO.Path]::GetFullPath($Options.AzureConfigDir)
  $defaultConfig = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.azure'))
  if (-not [IO.Path]::IsPathRooted($Options.AzureConfigDir) -or
      $config.TrimEnd('\') -ieq $defaultConfig.TrimEnd('\') -or
      $config.StartsWith($defaultConfig.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $config -PathType Container)) {
    throw 'AzureConfigDir must be an existing absolute isolated directory, never the default .azure directory.'
  }
  $configItem = Get-Item -LiteralPath $config
  while ($null -ne $configItem) {
    if ($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'AzureConfigDir must not traverse a link or junction.'
    }
    $configItem = $configItem.Parent
  }
  if (-not [IO.Path]::IsPathRooted($Options.AcaBin) -or -not (Test-Path -LiteralPath $Options.AcaBin -PathType Leaf)) {
    throw 'AcaBin must be an absolute path to the installed pinned ACA executable.'
  }

  $changes = @{
    AZURE_CONFIG_DIR = $config
    SQUAD_SANDBOX_AZURE_SUBSCRIPTION_ID = $Options.SubscriptionId
    SQUAD_SANDBOX_AZURE_TENANT_ID = $Options.TenantId
    SQUAD_SANDBOX_REGION = $Options.Region
    SQUAD_SANDBOX_RESOURCE_GROUP_NAME = $Options.ResourceGroup
    SQUAD_SANDBOX_GROUP_NAME = $Options.SandboxGroup
    SQUAD_SANDBOX_IMAGE_PULL_CLIENT_ID = $Options.ImagePullClientId
    SQUAD_ACA_BIN = $Options.AcaBin
    SQUAD_SANDBOX_IMAGE_REF = $Options.ImageRef
    SQUAD_ENABLE_ACA_SANDBOX = '0'
    SQUAD_ENABLE_PUBLISH = '0'
    SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT = '0'
    # Operator login is the isolated Azure CLI account, not an inherited service identity.
    AZURE_CLIENT_ID = $null
    MSI_ENDPOINT = $null
    IDENTITY_ENDPOINT = $null
    ACA_SANDBOX_MANAGED_IDENTITY = $null
    GITHUB_REPOSITORY = $null
  }
  $saved = @{}
  foreach ($entry in Get-ChildItem Env:) {
    if ($entry.Name -match '(?i)TOKEN|SECRET|PASSWORD|PAT$') { $changes[$entry.Name] = $null }
  }
  foreach ($name in $changes.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    foreach ($name in $changes.Keys) { Set-LabProcessEnvironment $name $changes[$name] }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $az = (Get-Command az -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $repo = [IO.Path]::GetFullPath($Options.RepoPath)
    $helper = Join-Path $PSScriptRoot '..\..\dispatcher\local-preflight.js'
    $inputOptions = @{
      repoRoot = $repo; planPath = $Options.PlanPath; repository = $Options.Repository
      issueNumber = $Options.IssueNumber; imageRef = $Options.ImageRef; outDir = $Options.OutDir
      concurrency = $Options.Concurrency; timeoutMs = $Options.TimeoutMs
      preflightOnly = $true; allowUnverifiedClient = [bool]$Options.AllowUnverifiedClient
    }
    $validation = (Invoke-LabRead $node @($helper, ($inputOptions | ConvertTo-Json -Compress))) | ConvertFrom-Json
    $version = Invoke-LabRead $Options.AcaBin @('--version')
    if ($version.Trim() -cne 'aca 1.0.0-preview.4') { throw 'ACA version must be the verified 1.0.0-preview.4; revalidate before changing it.' }
    $nodeVersion = Invoke-LabRead $node @('--version')
    if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node 22 or newer is required.' }
    $null = Invoke-LabRead $az @('version', '--output', 'json')
    $account = (Invoke-LabRead $az @('account', 'show', '--subscription', $Options.SubscriptionId,
      '--query', '{id:id,tenantId:tenantId,isDefault:isDefault,state:state}', '--output', 'json')) | ConvertFrom-Json
    if ($account.id -cne $Options.SubscriptionId -or $account.tenantId -cne $Options.TenantId -or
        $account.isDefault -ne $true -or $account.state -cne 'Enabled') {
      throw 'Isolated account must be Enabled and default to the configured subscription and tenant. No account set or login attempted.'
    }
    $groupId = "/subscriptions/$($Options.SubscriptionId)/resourceGroups/$($Options.ResourceGroup)/providers/Microsoft.App/sandboxGroups/$($Options.SandboxGroup)"
    $group = (Invoke-LabRead $az @('resource', 'show', '--ids', $groupId, '--subscription', $Options.SubscriptionId,
      '--query', '{id:id,location:location,state:properties.provisioningState}', '--output', 'json')) | ConvertFrom-Json
    if ($group.id -ine $groupId -or $group.location -cne $Options.Region -or $group.state -cne 'Succeeded') {
      throw 'Sandbox Group scope, region or provisioning state does not match the supplied configuration.'
    }
    $pullId = "/subscriptions/$($Options.SubscriptionId)/resourceGroups/$($Options.ResourceGroup)/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$($Options.ImagePullIdentityName)"
    $pull = (Invoke-LabRead $az @('identity', 'show', '--ids', $pullId, '--subscription', $Options.SubscriptionId,
      '--query', '{id:id,clientId:clientId,tenantId:tenantId}', '--output', 'json')) | ConvertFrom-Json
    if ($pull.id -ine $pullId -or $pull.clientId -cne $Options.ImagePullClientId -or $pull.tenantId -cne $Options.TenantId) {
      throw 'Image-pull identity does not match the configured client and tenant.'
    }
    $scope = @('--region', $Options.Region, '--subscription', $Options.SubscriptionId, '--resource-group', $Options.ResourceGroup)
    $sandboxes = (Invoke-LabRead $Options.AcaBin ($scope + @('sandbox', 'list', '--group', $Options.SandboxGroup, '-o', 'json'))) | ConvertFrom-Json
    $disks = (Invoke-LabRead $Options.AcaBin ($scope + @('sandboxgroup', 'disk', 'list', '--group', $Options.SandboxGroup, '-o', 'json'))) | ConvertFrom-Json
    Write-Output "Read-only preflight: $version; Node $nodeVersion; configured isolated account/group/pull identity confirmed."
    Write-Output "Inventory: $(@($sandboxes).Count) sandboxes, $(@($disks).Count) disk images; no resources modified."
    if (@($sandboxes).Count -ne 0) { throw 'Sandbox Group is not empty. Review existing work; this helper never deletes shared resources.' }
    if (@($validation.blockers).Count -gt 0) { throw ("Not live-ready: " + ($validation.blockers -join ' ')) }
    if ($Options.PreflightOnly) {
      Write-Output 'Configuration and plan checks passed only. No licensed token, image contents or full live flow verified; no dispatch or publication.'
      return
    }
    $inputOptions.preflightOnly = $false
    if (-not $saved['SQUAD_COPILOT_TOKEN'] -or -not $saved['SQUAD_COPILOT_TOKEN'].StartsWith('github_pat_')) {
      throw 'Real operation requires a caller-supplied licensed fine-grained SQUAD_COPILOT_TOKEN (github_pat_).'
    }
    if (-not $Options.OutDir -or (Test-Path -LiteralPath $Options.OutDir)) {
      throw 'OutDir must name a new run-specific directory.'
    }
    $env:SQUAD_COPILOT_TOKEN = $saved['SQUAD_COPILOT_TOKEN']
    try {
      $null = Invoke-LabRead $node @($helper, ($inputOptions | ConvertTo-Json -Compress))
      $env:SQUAD_ENABLE_ACA_SANDBOX = '1'
      $env:SQUAD_ALLOW_UNVERIFIED_ACA_CLIENT = '1'
      $cli = Join-Path $PSScriptRoot '..\..\dispatcher\cli.js'
      & $node $cli dispatch --plan $validation.planPath --repo $repo --out $Options.OutDir --client aca `
        --repo-full-name $Options.Repository --issue-number $Options.IssueNumber --concurrency 1 --timeout-ms $Options.TimeoutMs
      if ($LASTEXITCODE -ne 0) { throw 'Dispatcher failed. Inspect its sanitized summary and exact-ID cleanup errors; do not retry blindly.' }
    } finally {
      Set-LabProcessEnvironment 'SQUAD_COPILOT_TOKEN' $null
    }
  } finally {
    foreach ($name in $saved.Keys) { Set-LabProcessEnvironment $name $saved[$name] }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $options = @{}
  foreach ($name in $MyInvocation.MyCommand.Parameters.Keys) {
    $value = Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $value) { $options[$name] = $value }
  }
  Invoke-SandboxLabLocal $options
}
