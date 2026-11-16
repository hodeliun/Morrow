$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourcePath = Join-Path $PSScriptRoot 'windows-preflight.ps1'
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  $details = ($parseErrors | ForEach-Object { $_.Message }) -join '; '
  throw "windows-preflight.ps1 failed PowerShell parsing: $details"
}

. $sourcePath -LibraryOnly
Add-Type -AssemblyName System.IO.Compression

$script:assertionCount = 0
function Assert-True([bool] $Condition, [string] $Label) {
  $script:assertionCount++
  if (-not $Condition) { throw "Assertion failed: $Label" }
}

function Assert-Throws([string] $Label, [scriptblock] $Action) {
  $script:assertionCount++
  $thrown = $false
  try { & $Action } catch { $thrown = $true }
  if (-not $thrown) { throw "Expected failure was not raised: $Label" }
}

Assert-True ($null -eq (Assert-SafeDriverInvocation 'C:\tools\msedgedriver.exe' @('--version'))) 'msedgedriver version probe is the only permitted driver invocation'
Assert-Throws 'msedgedriver service arguments are rejected before process start' {
  Assert-SafeDriverInvocation 'C:\tools\msedgedriver.exe' @('--port', '0')
}
Assert-Throws 'tauri-driver is never invoked as a server or version probe' {
  Assert-SafeDriverInvocation 'C:\tools\tauri-driver.exe' @('--help')
}

$script:orchestrationReceipt = [ordered]@{ status = 'initializing'; appLaunched = $false; driverServiceStarted = $false }
$script:stageDispatchCount = 0
$script:checkOnlyDispatchCount = 0
$stageAction = {
  $script:stageDispatchCount++
  $script:orchestrationReceipt = Set-PreflightReceiptStatus $script:orchestrationReceipt 'staged'
  return [pscustomobject]@{ status = $script:orchestrationReceipt.status; appLaunched = $false; driverServiceStarted = $false }
}
$checkOnlyAction = {
  $script:checkOnlyDispatchCount++
  if ($script:orchestrationReceipt.status -ne 'staged') { throw 'CheckOnly must follow Stage.' }
  $script:orchestrationReceipt = Set-PreflightReceiptStatus $script:orchestrationReceipt 'passed'
  return [pscustomobject]@{ status = $script:orchestrationReceipt.status; appLaunched = $false; driverServiceStarted = $false }
}
$stageDispatchResult = Invoke-PreflightMode 'Stage' $stageAction $checkOnlyAction
Assert-True ($stageDispatchResult.status -eq 'staged' -and $script:stageDispatchCount -eq 1 -and $script:checkOnlyDispatchCount -eq 0) 'Stage dispatch and initializing-to-staged receipt transition'
$checkOnlyDispatchResult = Invoke-PreflightMode 'CheckOnly' $stageAction $checkOnlyAction
Assert-True ($checkOnlyDispatchResult.status -eq 'passed' -and $script:checkOnlyDispatchCount -eq 1 -and $script:orchestrationReceipt.status -eq 'passed') 'CheckOnly dispatch and staged-to-passed receipt transition'
Assert-True (-not $checkOnlyDispatchResult.appLaunched -and -not $checkOnlyDispatchResult.driverServiceStarted) 'orchestration stubs preserve no-launch boundary'
Assert-Throws 'receipt lifecycle rejects passed-to-failed transition' { Set-PreflightReceiptStatus $script:orchestrationReceipt 'failed' }
$interruptedReceipt = Set-PreflightReceiptFailure ([pscustomobject]@{ status = 'staged' }) 'synthetic interrupted check-only' '2026-11-16T00:00:00Z'
Assert-True ($interruptedReceipt.status -eq 'failed' -and $interruptedReceipt.failure -eq 'synthetic interrupted check-only' -and
  $interruptedReceipt.completedAtUtc -eq '2026-11-16T00:00:00Z') 'failure receipt adds fields absent from a staged PSCustomObject'

function New-ZipFixture([string] $Path, [object[]] $Entries) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in $Entries) {
      $entry = $archive.CreateEntry([string]$item.Name, [IO.Compression.CompressionLevel]::NoCompression)
      if ($item.ContainsKey('ExternalAttributes') -and $null -ne $item['ExternalAttributes']) {
        $entry.ExternalAttributes = [int]$item['ExternalAttributes']
      }
      $entryStream = $entry.Open()
      try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item.Content)
        $entryStream.Write($bytes, 0, $bytes.Length)
      } finally {
        $entryStream.Dispose()
      }
    }
  } finally {
    $archive.Dispose()
  }
}

function Corrupt-StoredZipPayload([string] $Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ([BitConverter]::ToUInt32($bytes, 0) -ne 0x04034b50) { throw 'Test ZIP has an unexpected local header.' }
  $nameLength = [BitConverter]::ToUInt16($bytes, 26)
  $extraLength = [BitConverter]::ToUInt16($bytes, 28)
  $payloadOffset = 30 + $nameLength + $extraLength
  if ($payloadOffset -ge $bytes.Length) { throw 'Test ZIP has no stored payload byte.' }
  $bytes[$payloadOffset] = $bytes[$payloadOffset] -bxor 0xFF
  [IO.File]::WriteAllBytes($Path, $bytes)
}

$runnerTemp = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($runnerTemp) -or -not [IO.Directory]::Exists($runnerTemp)) {
  throw 'windows-preflight tests require an existing Windows RUNNER_TEMP directory.'
}
$testRoot = Join-Path $runnerTemp ('morrow-preflight-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)

try {
  $validZip = Join-Path $testRoot 'valid.zip'
  New-ZipFixture $validZip @(
    @{ Name = 'DemoVault/index.md'; Content = 'synthetic vault' },
    @{ Name = 'payload.bin'; Content = 'pilot' }
  )
  $validResult = Assert-ZipArchiveSafe $validZip
  Assert-True ($validResult.EntryCount -eq 2) 'valid ZIP entry count'
  Assert-True ($validResult.TotalUncompressedBytes -gt 0) 'valid ZIP CRC/content traversal'
  $expanded = Join-Path $testRoot 'valid-extracted'
  [void](Expand-SafeZipArchive $validZip $expanded)
  Assert-True ([IO.File]::ReadAllText((Join-Path $expanded 'DemoVault/index.md')) -eq 'synthetic vault') 'safe ZIP extraction'

  $launcherArchive = Join-Path $testRoot 'launcher.zip'
  $launcherPackage = Join-Path $testRoot 'launcher-package'
  [void][IO.Directory]::CreateDirectory($launcherPackage)
  $launcherContents = 'synthetic check-only launcher bytes'
  New-ZipFixture $launcherArchive @(@{ Name = 'windows-launch.ps1'; Content = $launcherContents })
  $launcherPath = Join-Path $launcherPackage 'windows-launch.ps1'
  [IO.File]::WriteAllText($launcherPath, $launcherContents, [Text.UTF8Encoding]::new($false))
  $launcherCheck = Assert-StagedLauncherMatchesZip $launcherArchive $launcherPackage
  Assert-True ($launcherCheck.sha256 -eq (Get-Sha256 $launcherPath)) 'extracted launcher matches the verified inner ZIP entry'
  [IO.File]::WriteAllText($launcherPath, 'tampered launcher', [Text.UTF8Encoding]::new($false))
  Assert-Throws 'tampered extracted launcher rejected before execution' { Assert-StagedLauncherMatchesZip $launcherArchive $launcherPackage }
  [IO.File]::WriteAllText($launcherPath, $launcherContents, [Text.UTF8Encoding]::new($false))
  $launcherJunction = Join-Path $testRoot 'launcher-junction'
  [void](New-Item -ItemType Junction -Path $launcherJunction -Target $launcherPackage -ErrorAction Stop)
  try {
    Assert-Throws 'reparse package launcher rejected before execution' { Assert-StagedLauncherMatchesZip $launcherArchive $launcherJunction }
  } finally {
    [IO.Directory]::Delete($launcherJunction)
  }

  $traversalZip = Join-Path $testRoot 'traversal.zip'
  New-ZipFixture $traversalZip @(@{ Name = '../outside.txt'; Content = 'no-write' })
  Assert-Throws 'ZIP traversal rejected before extraction' { Assert-ZipArchiveSafe $traversalZip }
  Assert-True (-not [IO.File]::Exists((Join-Path $testRoot 'outside.txt'))) 'traversal did not write outside staging'

  $absoluteZip = Join-Path $testRoot 'absolute.zip'
  New-ZipFixture $absoluteZip @(@{ Name = '/outside.txt'; Content = 'no-write' })
  Assert-Throws 'absolute ZIP path rejected' { Assert-ZipArchiveSafe $absoluteZip }

  $streamZip = Join-Path $testRoot 'stream.zip'
  New-ZipFixture $streamZip @(@{ Name = 'file.txt:alternate'; Content = 'no-stream' })
  Assert-Throws 'ZIP alternate data stream rejected' { Assert-ZipArchiveSafe $streamZip }

  $caseZip = Join-Path $testRoot 'casefold.zip'
  New-ZipFixture $caseZip @(
    @{ Name = 'PilotState/a.txt'; Content = 'one' },
    @{ Name = 'pilotstate/b.txt'; Content = 'two' }
  )
  Assert-Throws 'case-folded parent path collision rejected' { Assert-ZipArchiveSafe $caseZip }

  $duplicateZip = Join-Path $testRoot 'duplicate.zip'
  New-ZipFixture $duplicateZip @(
    @{ Name = 'same.txt'; Content = 'one' },
    @{ Name = 'same.txt'; Content = 'two' }
  )
  Assert-Throws 'duplicate ZIP entry rejected' { Assert-ZipArchiveSafe $duplicateZip }

  $linkZip = Join-Path $testRoot 'link.zip'
  $symlinkAttributes = -1577123840
  New-ZipFixture $linkZip @(@{ Name = 'link.txt'; Content = 'target'; ExternalAttributes = $symlinkAttributes })
  Assert-Throws 'ZIP symlink rejected' { Assert-ZipArchiveSafe $linkZip }

  $crcZip = Join-Path $testRoot 'crc.zip'
  New-ZipFixture $crcZip @(@{ Name = 'data.bin'; Content = 'stored bytes that will be corrupted' })
  Corrupt-StoredZipPayload $crcZip
  Assert-Throws 'CRC mismatch rejected' { Assert-ZipArchiveSafe $crcZip }

  Assert-Throws 'uncompressed-size limit enforced' { Assert-ZipArchiveSafe $validZip 8 8 }
  Assert-Throws 'UNC path rejected' { Assert-LocalNormalizedPath '\\server\share\case' 'test UNC' }
  Assert-Throws 'dot-segment path rejected' { Assert-LocalNormalizedPath 'C:\temporary\..\case' 'test dot segment' }
  Assert-Throws 'alternate stream path rejected' { Assert-LocalNormalizedPath 'C:\temporary\case:stream' 'test ADS' }
  Assert-Throws 'drive-relative path rejected' { Assert-LocalNormalizedPath 'C:temporary\case' 'test drive-relative' }
  Assert-Throws 'ZIP repeated separator rejected' { Get-ZipEntryPath 'safe//file.txt' $false }

  $collisionPath = Join-Path $testRoot 'CaseCollision'
  [void][IO.Directory]::CreateDirectory($collisionPath)
  Assert-Throws 'case-insensitive path collision preserved' {
    Assert-NoPathCollision (Join-Path $testRoot 'casecollision') 'test collision'
  }
  Assert-True ([IO.Directory]::Exists($collisionPath)) 'existing collision path was not removed'
  $junctionPath = Join-Path $testRoot 'owned-junction'
  [void](New-Item -ItemType Junction -Path $junctionPath -Target $expanded -ErrorAction Stop)
  Assert-Throws 'junction path rejected' { Assert-NoReparsePath (Join-Path $junctionPath 'child') 'test junction' }
  [IO.Directory]::Delete($junctionPath)

  $paths = Get-PreflightPaths $runnerTemp ('test-' + [Guid]::NewGuid().ToString('N')) '1' ('a' * 40)
  Assert-True (-not [IO.Directory]::Exists($paths.PlannedRoot)) 'planned outputs remain absent'
  Assert-True ($paths.MorrowUserData.StartsWith($paths.Profile, [StringComparison]::OrdinalIgnoreCase)) 'backend profile plan is nested under synthetic profile'
  Assert-True ($paths.WebView2UserData.StartsWith($paths.Profile, [StringComparison]::OrdinalIgnoreCase)) 'WebView2 profile plan is nested under synthetic profile'

  $sameVersion = @(
    [pscustomobject]@{ Present = $true; Value = '157.0.4341.60'; Kind = 'REG_SZ'; RegistryPath = 'HKLM64 test' },
    [pscustomobject]@{ Present = $true; Value = '157.0.4341.60'; Kind = 'REG_SZ'; RegistryPath = 'HKCU64 test' }
  )
  Assert-True ((Select-WebView2RuntimeVersion $sameVersion).Version -eq '157.0.4341.60') 'matching documented pv keys selected'
  Assert-Throws 'absent WebView2 runtime rejected' {
    Select-WebView2RuntimeVersion @([pscustomobject]@{ Present = $false; Value = $null; Kind = $null; RegistryPath = 'absent' })
  }
  Assert-Throws 'conflicting machine/user pv rejected' {
    Select-WebView2RuntimeVersion @(
      [pscustomobject]@{ Present = $true; Value = '157.0.4341.60'; Kind = 'REG_SZ'; RegistryPath = 'HKLM64 test' },
      [pscustomobject]@{ Present = $true; Value = '157.0.4341.61'; Kind = 'REG_SZ'; RegistryPath = 'HKCU64 test' }
    )
  }
  Assert-Throws 'invalid registry pv rejected' {
    Select-WebView2RuntimeVersion @([pscustomobject]@{ Present = $true; Value = ''; Kind = 'REG_SZ'; RegistryPath = 'HKCU64 test' })
  }
  $cargoListWithExe = "tauri-driver v2.1.0:`r`n    tauri-driver.exe`r`n"
  $cargoListWithoutExe = "tauri-driver v2.1.0:`r`n    tauri-driver`r`n"
  Assert-True ((Get-CargoInstalledPackageVersion $cargoListWithExe 'tauri-driver' '2.1.0') -eq '2.1.0') 'Cargo installed metadata pins tauri-driver 2.1.0 with Windows binary suffix'
  Assert-True ((Get-CargoInstalledPackageVersion $cargoListWithoutExe 'tauri-driver' '2.1.0') -eq '2.1.0') 'Cargo installed metadata accepts the binary name without an extension'
  Assert-Throws 'Cargo installed metadata rejects a different tauri-driver version' {
    Get-CargoInstalledPackageVersion "tauri-driver v2.2.0:`r`n    tauri-driver.exe`r`n" 'tauri-driver' '2.1.0'
  }
  $edgePageFixture = @'
<a href="https://msedgedriver.microsoft.com/157.0.4341.36/edgedriver_win64.zip">old patch</a>
<a href="https://msedgedriver.microsoft.com/157.0.4341.57/edgedriver_win64.zip">latest matching patch</a>
<a href="https://msedgedriver.microsoft.com/158.0.4370.21/edgedriver_win64.zip">different build</a>
'@
  $edgeRelease = Select-OfficialEdgeDriverRelease '157.0.4341.60' $edgePageFixture
  Assert-True ($edgeRelease.Version -eq '157.0.4341.57') 'official EdgeDriver candidate selected by WebView2 first three components'
  Assert-Throws 'no matching official EdgeDriver build rejected' {
    Select-OfficialEdgeDriverRelease '159.0.4393.0' $edgePageFixture
  }

  $known = Get-WindowsKnownFolderPaths
  Assert-True ([IO.Directory]::Exists($known.LocalAppData)) 'real LocalAppData KnownFolder resolved'
  Assert-True ([IO.Directory]::Exists($known.RoamingAppData)) 'real RoamingAppData KnownFolder resolved'
  $identity = Get-CurrentWindowsIdentity
  Assert-True (-not [string]::IsNullOrWhiteSpace($identity.Sid)) 'current Windows SID resolved'
  Write-Output "windows-preflight own tests passed ($script:assertionCount assertions); tests created no app, driver, registry, profile, or planned pilot paths."
} finally {
  if ([IO.Directory]::Exists($testRoot)) {
    Assert-NoReparsePath $testRoot 'Owned test temporary root' | Out-Null
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
