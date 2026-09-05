[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$issuer = $null
$secret = $null
$process = $null
try {
    if ([Console]::IsInputRedirected) { throw 'Interactive input required.' }
    Write-Host 'Run this in a separate local window after closing unrestricted Codex sessions.'
    Write-Host 'Use only credentials issued by Mozilla. Do not start signing during this operation.'
    Write-Host 'Without -Apply, this only checks access and does not store anything.'
    $issuer = Read-Host 'Mozilla JWT issuer (hidden)' -AsSecureString
    $secret = Read-Host 'Mozilla JWT secret (hidden)' -AsSecureString
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $receiver = Join-Path $PSScriptRoot 'receive-amo-credentials.js'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.Arguments = '"{0}"' -f $receiver
    $start.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @($start.EnvironmentVariables.Keys)) {
        if ($name -notmatch '^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|ProgramFiles|ProgramFiles\(x86\))$') {
            $start.EnvironmentVariables.Remove($name)
        }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    if (-not $process.Start()) { throw 'Start failed.' }
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    $issuerPointer = [IntPtr]::Zero
    $secretPointer = [IntPtr]::Zero
    try {
        $issuerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($issuer)
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $payload = @{
            issuer = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($issuerPointer)
            secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
            apply = [bool]$Apply
        }
        $process.StandardInput.Write(($payload | ConvertTo-Json -Compress))
        $process.StandardInput.Close()
        $payload.Clear()
        $payload = $null
    } finally {
        if ($issuerPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($issuerPointer) }
        if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    }
    if (-not $process.WaitForExit(300000)) { $process.Kill(); throw 'Operation timed out.' }
    $outTask.Wait()
    $errTask.Wait()
    $result = $outTask.Result | ConvertFrom-Json
    if ($result.status -notin @('validated_only','stored_signing_unverified','metadata_unverified','partial_update_stop','failed')) {
        throw 'Unexpected status.'
    }
    Write-Host ('Status: ' + $result.status)
    Write-Host ('Provider verification: ' + [bool]$result.providerVerified)
    Write-Host ('Stored entries: ' + [int]$result.storedCount)
    Write-Host 'Signing verification and old-key revocation remain separate pending steps.'
    exit $process.ExitCode
} catch {
    Write-Host 'Operation failed. Details suppressed. Do not start signing or assume that old credentials were revoked.'
    exit 1
} finally {
    if ($null -ne $issuer) { $issuer.Dispose() }
    if ($null -ne $secret) { $secret.Dispose() }
    if ($null -ne $process) { $process.Dispose() }
}
