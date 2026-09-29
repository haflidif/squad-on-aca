param(
  [Parameter(Mandatory = $true)][string]$Outputs,
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][string]$Environment,
  [switch]$Apply,
  [switch]$AllowSelfReview
)
$ErrorActionPreference = 'Stop'
$arguments = @(
  (Join-Path $PSScriptRoot 'sandbox-lab-bootstrap.js'),
  '--outputs', $Outputs,
  '--repo', $Repository,
  '--environment', $Environment
)
if ($Apply) { $arguments += '--apply' }
if ($AllowSelfReview) { $arguments += '--allow-self-review' }
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
