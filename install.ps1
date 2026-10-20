[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Alias('Ref')][string]$Version,
    [Parameter(Mandatory = $true)][string]$Target,
    [ValidateSet('jobs', 'sandbox')][string]$Backend = 'jobs',
    [switch]$Preview,
    [switch]$Strict,
    [switch]$OpenPr
)
$ErrorActionPreference = 'Stop'
$installerArgs = @((Join-Path $PSScriptRoot 'scripts\install.cjs'), '--version', $Version, '--target', $Target, '--backend', $Backend)
if ($Preview) { $installerArgs += '--preview' }
if ($Strict) { $installerArgs += '--strict' }
if ($OpenPr) { $installerArgs += '--open-pr' }
& node @installerArgs
exit $LASTEXITCODE
