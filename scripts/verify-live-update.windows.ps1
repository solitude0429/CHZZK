#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){2}$')]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$SourceSha,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$SignedXpiSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The production update readback requires Windows.'
}

$origin = 'https://chzzk.home.arpa:8443'
$addOnId = 'chzzk@solitude0429.local'
$expectedXpiUrl = "$origin/releases/$Version/chzzk-$Version-signed.xpi"
$temporaryXpi = [IO.Path]::GetTempFileName()

try {
    $manifestResponse = Invoke-WebRequest `
        -Uri "$origin/updates.json" `
        -UseBasicParsing `
        -MaximumRedirection 0 `
        -TimeoutSec 15
    if ($manifestResponse.StatusCode -ne 200) {
        throw 'Update manifest did not return HTTP 200.'
    }
    $manifestType = ([string]$manifestResponse.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
    if ($manifestType -ne 'application/json') {
        throw "Update manifest MIME is not application/json: $manifestType"
    }
    $manifest = $manifestResponse.Content | ConvertFrom-Json
    $addOn = $manifest.addons.PSObject.Properties[$addOnId].Value
    if ($null -eq $addOn -or @($addOn.updates).Count -ne 1) {
        throw 'Update manifest does not contain one canonical add-on update.'
    }
    $update = @($addOn.updates)[0]
    if (
        [string]$update.version -ne $Version -or
        [string]$update.update_link -ne $expectedXpiUrl -or
        [string]$update.update_hash -ne "sha256:$SignedXpiSha256"
    ) {
        throw 'Update manifest identity differs from the requested release.'
    }

    $xpiResponse = Invoke-WebRequest `
        -Uri $expectedXpiUrl `
        -OutFile $temporaryXpi `
        -PassThru `
        -UseBasicParsing `
        -MaximumRedirection 0 `
        -TimeoutSec 30
    if ($xpiResponse.StatusCode -ne 200) {
        throw 'Signed XPI did not return HTTP 200.'
    }
    $xpiType = ([string]$xpiResponse.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
    if ($xpiType -ne 'application/x-xpinstall') {
        throw "Signed XPI MIME is not application/x-xpinstall: $xpiType"
    }
    $actualXpiSha = (Get-FileHash -LiteralPath $temporaryXpi -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualXpiSha -ne $SignedXpiSha256) {
        throw 'Production signed XPI bytes differ from the verified Release.'
    }

    $provenanceResponse = Invoke-WebRequest `
        -Uri "$origin/provenance.json" `
        -UseBasicParsing `
        -MaximumRedirection 0 `
        -TimeoutSec 15
    if ($provenanceResponse.StatusCode -ne 200) {
        throw 'Production provenance did not return HTTP 200.'
    }
    $provenance = $provenanceResponse.Content | ConvertFrom-Json
    $signedName = "chzzk-$Version-signed.xpi"
    if (
        [string]$provenance.version -ne $Version -or
        [string]$provenance.sourceDigest -ne $SourceSha -or
        [string]$provenance.sourceRepository -ne 'solitude0429/CHZZK' -or
        [string]$provenance.assets.PSObject.Properties[$signedName].Value -ne $SignedXpiSha256
    ) {
        throw 'Production provenance differs from the verified Release.'
    }

    [ordered]@{
        manifestMime = $manifestType
        schemaVersion = 1
        signedXpiMime = $xpiType
        signedXpiSha256 = $actualXpiSha
        sourceSha = $SourceSha
        status = 'passed'
        version = $Version
    } | ConvertTo-Json -Compress
}
finally {
    if (Test-Path -LiteralPath $temporaryXpi -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryXpi -Force
    }
}
