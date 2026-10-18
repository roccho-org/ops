$ErrorActionPreference = 'Stop'

function New-PrivateSetupDirectory([string]$Path) {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            @(Get-ChildItem -LiteralPath $Path -Force).Count -ne 0) { throw 'SETUP_DIRECTORY_EXISTS_STOP' }
    } else {
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($sid)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        New-Item -ItemType Directory -Path $Path | Out-Null
        Set-Acl -LiteralPath $Path -AclObject $acl
    }
    $actual = Get-Acl -LiteralPath $Path
    $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
        $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
        $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or
        $rules[0].InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or $rules[0].PropagationFlags -ne 'None') {
        throw 'PRIVATE_DIRECTORY_ACL_FAILED'
    }
}

function Invoke-SetupNode([string]$Node, [string]$Source, [string]$Gh, [string]$Handoff, [string]$InputJson, [switch]$Preflight) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($value in @($Source, '--handoff', $Handoff, '--gh', $Gh)) { $start.ArgumentList.Add($value) }
    if ($Preflight) { $start.ArgumentList.Add('--preflight') }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$Preflight) { $process.StandardInput.WriteLine($InputJson) }
        $process.StandardInput.Close()
        $process.WaitForExit()
        $text = if ($process.ExitCode -eq 0) { $stdout.GetAwaiter().GetResult() } else { $stderr.GetAwaiter().GetResult() }
        $value = $text | ConvertFrom-Json
        if ($process.ExitCode -ne 0) {
            # Print only the setup program's fixed status fields, never child stderr.
            $safe = @{ status = 'STOP'; code = 'SETUP_FAILED' }
            if ($value.code -cmatch '^[A-Z_]{1,80}$') { $safe.code = $value.code }
            if ($value.phase -in @('preflight', 'mozilla-register', 'x-register', 'github-secret')) { $safe.phase = $value.phase }
            if ($value.httpStatus -is [long] -and $value.httpStatus -ge 100 -and $value.httpStatus -le 599) { $safe.httpStatus = $value.httpStatus }
            Write-Host ($safe | ConvertTo-Json -Compress)
            throw 'SETUP_STOP'
        }
        if ($value.status -notin @('PREFLIGHT_OK', 'X_REQUEST_ACCEPTED_AND_SECRET_CONFIGURED')) { throw 'SETUP_RESULT_INVALID' }
        return $value
    } finally { $process.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    $auth = $null; $csrf = $null; $json = $null
    try {
        if (!$IsWindows -or !$env:LOCALAPPDATA) { throw 'WINDOWS_REQUIRED' }
        $node = (Get-Command node -CommandType Application).Source
        $gh = (Get-Command gh -CommandType Application).Source
        $source = Join-Path $PSScriptRoot 'setup-webpush.mjs'
        $directory = Join-Path $env:LOCALAPPDATA 'EventReservoirPoC'
        $handoff = Join-Path $directory 'subscription-handoff.jsonl'
        $null = Invoke-SetupNode $node $source $gh $handoff -Preflight
        New-PrivateSetupDirectory $directory
        Write-Host 'Enter only the two cookie values from your own logged-in x.com session. Input is hidden.'
        $auth = Read-Host 'auth_token' -AsSecureString
        $csrf = Read-Host 'ct0' -AsSecureString
        try {
            $authPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($auth)
            $csrfPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($csrf)
            $json = @{
                auth_token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($authPointer)
                ct0 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($csrfPointer)
            } | ConvertTo-Json -Compress
        } finally {
            if ($authPointer) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($authPointer) }
            if ($csrfPointer) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($csrfPointer) }
        }
        $result = Invoke-SetupNode $node $source $gh $handoff $json
        Write-Host ($result | ConvertTo-Json -Compress)
        Write-Host 'Registration request accepted and receiver secret configured. A real X notification still needs CI verification.'
    } catch {
        # Do not echo exception text: it can originate in a child process or input.
        Write-Host 'Setup stopped. No automatic retry. Keep any EventReservoirPoC handoff file for explicit recovery.'
        exit 1
    } finally {
        $json = $null
        if ($auth) { $auth.Dispose() }
        if ($csrf) { $csrf.Dispose() }
    }
}
