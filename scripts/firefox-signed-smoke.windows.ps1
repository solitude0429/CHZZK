#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeBinary,

    [Parameter(Mandatory = $true)]
    [string]$FirefoxBinary,

    [Parameter(Mandatory = $true)]
    [string]$GeckodriverBinary,

    [Parameter(Mandatory = $true)]
    [string]$ReleaseMetadata,

    [Parameter(Mandatory = $true)]
    [string]$SignedXpi,

    [Parameter(Mandatory = $true)]
    [string]$OldSignedXpi,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "The native signed-update smoke runner requires Windows."
}

function Resolve-RegularFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [switch]$RequireAbsolute
    )

    if ($RequireAbsolute -and -not [IO.Path]::IsPathFullyQualified($Path)) {
        throw "$Label must be an explicit absolute path."
    }

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if ($RequireAbsolute -and -not [IO.Path]::IsPathFullyQualified($resolved)) {
        throw "$Label did not resolve to an absolute path."
    }

    $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    if (
        $item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        $item.Length -le 0
    ) {
        throw "$Label must name a nonempty regular file."
    }
    return $resolved
}

$runner = Resolve-RegularFile `
    -Path (Join-Path $PSScriptRoot "firefox-signed-smoke.js") `
    -Label "signed-smoke runner"
$node = Resolve-RegularFile -Path $NodeBinary -Label "NodeBinary" -RequireAbsolute
$firefox = Resolve-RegularFile -Path $FirefoxBinary -Label "FirefoxBinary"
$geckodriver = Resolve-RegularFile -Path $GeckodriverBinary -Label "GeckodriverBinary"
$metadata = Resolve-RegularFile -Path $ReleaseMetadata -Label "ReleaseMetadata"
$signed = Resolve-RegularFile -Path $SignedXpi -Label "SignedXpi"
$oldSigned = Resolve-RegularFile -Path $OldSignedXpi -Label "OldSignedXpi"
$result = [IO.Path]::GetFullPath($ResultPath)
$resultParent = Split-Path -Parent $result
$resultParentItem = Get-Item -LiteralPath $resultParent -Force -ErrorAction Stop
if (
    -not $resultParentItem.PSIsContainer -or
    (($resultParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
) {
    throw "ResultPath parent must be a real directory."
}
if (Test-Path -LiteralPath $result) {
    throw "ResultPath must not already exist."
}

$nodeStartupEnvironmentNames = @(
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENSSL_CONF",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE"
)
$environmentValues = [ordered]@{
    "CHZZK_OLD_SIGNED_XPI" = $oldSigned
    "CHZZK_RELEASE_METADATA" = $metadata
    "CHZZK_SIGNED_SMOKE_MODE" = "update"
    "CHZZK_SIGNED_SMOKE_RESULT" = $result
    "CHZZK_SIGNED_XPI" = $signed
    "FIREFOX_BINARY" = $firefox
    "GECKODRIVER_BINARY" = $geckodriver
}
$previousEnvironment = @{}
$completed = $false
$resultCreated = $false

foreach ($name in $nodeStartupEnvironmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
foreach ($name in $environmentValues.Keys) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
    foreach ($name in $nodeStartupEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }

    $nodeMajorOutput = & $node -p "process.versions.node.split('.')[0]"
    $nodeVersionExitCode = $LASTEXITCODE
    $nodeMajorText = ([string]$nodeMajorOutput).Trim()
    if (
        $nodeVersionExitCode -ne 0 -or
        $nodeMajorText -notmatch "^[0-9]{1,3}$" -or
        [int]$nodeMajorText -lt 20
    ) {
        throw "Node.js 20 or newer is required."
    }

    foreach ($name in $environmentValues.Keys) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $environmentValues[$name],
            "Process"
        )
    }

    & $node $runner | Out-Null
    $runnerExitCode = $LASTEXITCODE
    $resultCreated = Test-Path -LiteralPath $result -PathType Leaf
    if ($runnerExitCode -ne 0) {
        throw "The native signed-update smoke failed."
    }
    if (-not $resultCreated) {
        throw "The native signed-update smoke did not persist its result."
    }

    $resultItem = Get-Item -LiteralPath $result -Force
    if (
        (($resultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        $resultItem.Length -le 0 -or
        $resultItem.Length -gt 4096
    ) {
        throw "The native signed-update smoke result is not a bounded regular file."
    }

    $evidence = Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedKeys = @(
        "extensionVersion",
        "finalUpdateState",
        "firefoxVersion",
        "installedState",
        "mode",
        "schemaVersion",
        "status"
    )
    $actualKeys = @($evidence.PSObject.Properties.Name | Sort-Object)
    if (@(Compare-Object -ReferenceObject $expectedKeys -DifferenceObject $actualKeys).Count -ne 0) {
        throw "The native signed-update smoke result schema is invalid."
    }
    if (
        $evidence.schemaVersion -ne 1 -or
        $evidence.status -ne "passed" -or
        $evidence.mode -ne "update" -or
        $evidence.installedState -ne "permanent-signed-active" -or
        $evidence.finalUpdateState -ne "none-found" -or
        ([string]$evidence.firefoxVersion -notmatch "^[0-9][0-9A-Za-z.+-]{0,31}$") -or
        ([string]$evidence.extensionVersion -notmatch "^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$")
    ) {
        throw "The native signed-update smoke result values are invalid."
    }

    $completed = $true
    [Console]::Out.WriteLine([IO.File]::ReadAllText($result))
}
finally {
    foreach ($name in $environmentValues.Keys) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $previousEnvironment[$name],
            "Process"
        )
    }
    foreach ($name in $nodeStartupEnvironmentNames) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $previousEnvironment[$name],
            "Process"
        )
    }
    if (-not $completed -and $resultCreated) {
        Remove-Item -LiteralPath $result -Force
    }
}
