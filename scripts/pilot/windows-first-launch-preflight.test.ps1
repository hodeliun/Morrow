$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourcePath = Join-Path $PSScriptRoot 'windows-first-launch-preflight.ps1'
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  $messages = ($parseErrors | ForEach-Object { $_.Message }) -join '; '
  throw "windows-first-launch-preflight.ps1 failed PowerShell parsing: $messages"
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

function Assert-ThrowsWithoutSecrets([string] $Label, [scriptblock] $Action, [string[]] $Secrets) {
  $script:assertionCount++
  $message = $null
  try { & $Action } catch { $message = [string]$_.Exception.Message }
  if ($null -eq $message) { throw "Expected failure was not raised: $Label" }
  foreach ($secret in $Secrets) {
    if ($message.Contains($secret)) { throw "Secret text escaped the boundary: $Label" }
  }
}

function Get-TestSha256([byte[]] $Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function New-TestZip([string] $Path, [object[]] $Entries) {
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in $Entries) {
      $entry = $archive.CreateEntry([string]$item.Name, [IO.Compression.CompressionLevel]::NoCompression)
      if ($item.Contains('ExternalAttributes') -and $null -ne $item.ExternalAttributes) {
        $entry.ExternalAttributes = [int]$item.ExternalAttributes
      }
      $output = $entry.Open()
      try {
        [byte[]]$bytes = [byte[]]::new(0)
        if ($item.Contains('Bytes') -and $item.Bytes -is [byte[]]) {
          $bytes = [byte[]]$item.Bytes
        } else {
          $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item.Content)
        }
        $output.Write($bytes, 0, $bytes.Length)
      } finally { $output.Dispose() }
    }
  } finally { $archive.Dispose() }
}

function Corrupt-TestZipPayload([string] $Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ([BitConverter]::ToUInt32($bytes, 0) -ne 0x04034b50) { throw 'Fixture ZIP has an unexpected local header.' }
  $nameLength = [BitConverter]::ToUInt16($bytes, 26)
  $extraLength = [BitConverter]::ToUInt16($bytes, 28)
  $payloadOffset = 30 + $nameLength + $extraLength
  $bytes[$payloadOffset] = $bytes[$payloadOffset] -bxor 0xFF
  [IO.File]::WriteAllBytes($Path, $bytes)
}

function Set-TestBytes([byte[]] $Target, [int] $Offset, [byte[]] $Value) {
  [Array]::Copy($Value, 0, $Target, $Offset, $Value.Length)
}

function New-TestPeBytes {
  $bytes = New-Object byte[] 512
  $bytes[0] = 0x4D
  $bytes[1] = 0x5A
  $peOffset = 0x80
  Set-TestBytes $bytes 0x3C ([BitConverter]::GetBytes([int]$peOffset))
  Set-TestBytes $bytes $peOffset ([Text.Encoding]::ASCII.GetBytes(('PE' + [char]0 + [char]0)))
  Set-TestBytes $bytes ($peOffset + 4) ([BitConverter]::GetBytes([uint16]0x8664))
  Set-TestBytes $bytes ($peOffset + 6) ([BitConverter]::GetBytes([uint16]1))
  Set-TestBytes $bytes ($peOffset + 20) ([BitConverter]::GetBytes([uint16]240))
  $optionalOffset = $peOffset + 24
  Set-TestBytes $bytes $optionalOffset ([BitConverter]::GetBytes([uint16]0x20B))
  Set-TestBytes $bytes ($optionalOffset + 128) ([BitConverter]::GetBytes([uint32]0x2000))
  Set-TestBytes $bytes ($optionalOffset + 132) ([BitConverter]::GetBytes([uint32]32))
  return ,$bytes
}

function Copy-TestCandidate {
  $json = ConvertTo-Json -InputObject (Get-FirstLaunchPins) -Depth 16 -Compress
  return (ConvertFrom-Json -InputObject $json -AsHashtable -DateKind String)
}

function New-TestPackageFixture([string] $Root) {
  $candidate = Copy-TestCandidate
  $candidate.artifact.expiresAtUtc = '2099-12-31T23:59:59.000Z'
  $packageRoot = Join-Path $Root 'package-fixture'
  [void][IO.Directory]::CreateDirectory($packageRoot)
  $inventory = [Collections.ArrayList]::new()

  foreach ($pinnedEntry in (Get-FirstLaunchInventory)) {
    $relative = [string]$pinnedEntry.path
    if ($relative -ceq 'morrow.exe') {
      $bytes = New-TestPeBytes
    } elseif ($relative -ceq 'DemoVault/.morrow/plugins/polaris-dados/manifest.json') {
      $bytes = [Text.Encoding]::UTF8.GetBytes('{"id":"polaris-dados","name":"Polaris Dados","version":"test"}')
    } else {
      $bytes = [Text.Encoding]::UTF8.GetBytes(('synthetic package fixture: ' + $relative + [Environment]::NewLine))
    }
    $nativePath = Join-Path $packageRoot ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($nativePath))
    [IO.File]::WriteAllBytes($nativePath, [byte[]]$bytes)
    [void]$inventory.Add([ordered]@{
      path = $relative
      sizeBytes = [long]$bytes.LongLength
      sha256 = Get-TestSha256 $bytes
    })
  }

  $inventoryArray = @($inventory.ToArray())
  $candidate.package.canonicalInventorySha256 = Get-TestSha256 (Get-FirstLaunchCanonicalInventoryBytes $inventoryArray)
  $candidate.package.fileInventoryCount = $inventoryArray.Count
  $candidate.package.executableSizeBytes = [long](@($inventoryArray | Where-Object { $_.path -ceq 'morrow.exe' })[0].sizeBytes)
  $candidate.package.executableSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'morrow.exe' })[0].sha256)
  $candidate.package.launcherSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'windows-launch.ps1' })[0].sha256)
  $candidate.package.launcherCmdSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'windows-launch.cmd' })[0].sha256)
  $candidate.package.mcpResourceSha256 = [string](@($inventoryArray | Where-Object { $_.path -ceq 'mcp/index.js' })[0].sha256)
  $candidate.package.demoVaultSha256 = Get-TestSha256 ([Text.Encoding]::UTF8.GetBytes('synthetic DemoVault tree'))

  $buildInfo = [ordered]@{
    schemaVersion = 1
    scope = 'synthetic first-launch fixture'
    applicationVersion = [string]$candidate.package.applicationVersion
    sourceBuildPlatform = 'windows-native'
    run = [ordered]@{ id = [string]$candidate.buildRunId; attempt = [string]$candidate.buildRunAttempt; sha = [string]$candidate.sourceSha }
    git = [ordered]@{ branch = [string]$candidate.branch; head = [string]$candidate.sourceSha; tree = [string]$candidate.sourceTree; status = 'clean' }
    runner = [ordered]@{ os = 'Windows'; architecture = 'X64' }
    appLaunched = $false
    windowsRuntimeTested = $false
    appGUIWindowsTested = $null
    pilotIdentifier = [string]$candidate.package.pilotIdentifier
    overlay = [ordered]@{
      path = [string]$candidate.package.overlayPath
      sha256 = [string]$candidate.package.overlaySha256
      identifier = [string]$candidate.package.pilotIdentifier
      bundleActive = $false
      mcpResourceSource = [string]$candidate.package.mcpResourceSource
      mcpResourceTarget = [string]$candidate.package.mcpResourceTarget
    }
    template = [ordered]@{ path = [string]$candidate.package.demoVaultPath; sha256 = [string]$candidate.package.demoVaultSha256 }
    fileInventory = $inventoryArray
    buildCommands = @(
      [ordered]@{ label = 'npm-ci'; command = 'npm ci'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'npm-check'; command = 'npm run check'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-fmt'; command = 'cargo fmt --check'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-clippy'; command = 'cargo clippy'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'cargo-test'; command = 'cargo test'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'tauri-windows-debug-build'; command = 'tauri build --debug --no-bundle --config src-tauri/tauri.pilot.conf.json'; status = 'passed'; exitCode = 0 },
      [ordered]@{ label = 'polaris-dados-plugin-build'; command = 'npm run build:polaris-dados'; status = 'passed'; exitCode = 0 }
    )
  }
  $buildInfoPath = Join-Path $packageRoot 'BUILD-INFO.json'
  $buildInfoJson = ConvertTo-Json -InputObject $buildInfo -Depth 14 -Compress
  [IO.File]::WriteAllText($buildInfoPath, $buildInfoJson, [Text.UTF8Encoding]::new($false))
  $candidate.package.buildInfoSizeBytes = (Get-Item -LiteralPath $buildInfoPath).Length
  $candidate.package.buildInfoSha256 = Get-Sha256 $buildInfoPath

  $sumLines = [Collections.Generic.List[string]]::new()
  $sumLines.Add(([string]$candidate.package.buildInfoSha256 + '  BUILD-INFO.json'))
  foreach ($entry in $inventoryArray) { $sumLines.Add(([string]$entry.sha256 + '  ' + [string]$entry.path)) }
  $sumsPath = Join-Path $packageRoot 'SHA256SUMS'
  [IO.File]::WriteAllText($sumsPath, (($sumLines -join [Environment]::NewLine) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $candidate.package.sha256SumsSizeBytes = (Get-Item -LiteralPath $sumsPath).Length
  $candidate.package.sha256SumsSha256 = Get-Sha256 $sumsPath

  $innerPath = Join-Path $Root 'inner-fixture.zip'
  $innerEntries = @(
    [pscustomobject]@{ Name = 'BUILD-INFO.json'; Path = $buildInfoPath },
    [pscustomobject]@{ Name = 'SHA256SUMS'; Path = $sumsPath }
  ) + @($inventoryArray | ForEach-Object {
    [pscustomobject]@{
      Name = [string]$_.path
      Path = Join-Path $packageRoot ([string]$_.path.Replace('/', [IO.Path]::DirectorySeparatorChar))
    }
  })
  $file = [IO.File]::Open($innerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($item in $innerEntries) {
      $entry = $archive.CreateEntry([string]$item.Name, [IO.Compression.CompressionLevel]::NoCompression)
      $input = [IO.File]::OpenRead([string]$item.Path)
      $output = $entry.Open()
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
  } finally { $archive.Dispose() }
  $candidate.package.innerEntryCount = $innerEntries.Count
  $candidate.package.innerTotalBytes = [long](($innerEntries | ForEach-Object { (Get-Item -LiteralPath $_.Path).Length } | Measure-Object -Sum).Sum)
  $candidate.package.innerSizeBytes = (Get-Item -LiteralPath $innerPath).Length
  $candidate.package.innerSha256 = Get-Sha256 $innerPath

  $outerPath = Join-Path $Root 'artifact-fixture.zip'
  New-TestZip $outerPath @(@{ Name = [string]$candidate.package.innerName; Bytes = [IO.File]::ReadAllBytes($innerPath) })
  $candidate.artifact.sizeBytes = (Get-Item -LiteralPath $outerPath).Length
  $candidate.package.outerSha256 = Get-Sha256 $outerPath
  $candidate.artifact.digest = 'sha256:' + [string]$candidate.package.outerSha256
  $metadata = [ordered]@{
    id = [long]$candidate.artifact.id
    name = [string]$candidate.artifact.name
    expired = $false
    size_in_bytes = [long]$candidate.artifact.sizeBytes
    digest = [string]$candidate.artifact.digest
    expires_at = [string]$candidate.artifact.expiresAtUtc
    workflow_run = [ordered]@{
      id = [long]$candidate.buildRunId
      head_sha = [string]$candidate.sourceSha
      head_branch = [string]$candidate.branch
    }
  }
  return [pscustomobject]@{
    candidate = $candidate
    expectedInventory = $inventoryArray
    packageRoot = $packageRoot
    innerZipPath = $innerPath
    outerZipPath = $outerPath
    metadataBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $metadata -Depth 8 -Compress))
    outerZipBytes = [IO.File]::ReadAllBytes($outerPath)
  }
}

function New-TestTransport([object] $Fixture, [string] $Mode = 'success') {
  $capturedCalls = [Collections.ArrayList]::new()
  $capturedFixture = $Fixture
  $capturedMode = $Mode
  $script:transportCalls = $capturedCalls
  $transport = {
    param($Request)
    [void]$capturedCalls.Add($Request)
    $index = $capturedCalls.Count
    switch ($index) {
      1 {
        if ($capturedMode -eq 'transport-secret') {
          throw 'synthetic transport failure https://host.invalid/blob?sv=secret&sig=FAKE_SAS_MUST_NOT_LEAK synthetic-api-token'
        }
        $body = [byte[]]$capturedFixture.metadataBytes
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'metadata-status') { 404 } else { 200 }
          Headers = [ordered]@{ 'Content-Length' = [string]$body.LongLength }
          BodyBytes = $body
        }
      }
      2 {
        $location = 'https://productionresultssa16.blob.core.windows.net/container/artifact.zip?sv=synthetic&sig=FAKE_SAS_MUST_NOT_LEAK'
        if ($capturedMode -eq 'redirect-host') { $location = 'https://attacker.example/blob?sig=FAKE_SAS_MUST_NOT_LEAK' }
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'redirect-status') { 200 } else { 302 }
          Headers = [ordered]@{ Location = $location; 'Content-Length' = '0' }
          BodyBytes = [byte[]]@()
        }
      }
      3 {
        $body = [byte[]]$capturedFixture.outerZipBytes
        $length = $body.LongLength
        if ($capturedMode -eq 'blob-length') { $length++ }
        if ($capturedMode -eq 'blob-digest') { $body[0] = $body[0] -bxor 0xFF }
        return [pscustomobject]@{
          StatusCode = if ($capturedMode -eq 'blob-status') { 302 } else { 200 }
          Headers = [ordered]@{ 'Content-Length' = [string]$length }
          BodyBytes = $body
        }
      }
      default { throw 'Unexpected extra HTTP request.' }
    }
  }
  return $transport.GetNewClosure()
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('morrow-first-launch-preflight-tests-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$readOnlyTree = $null
try {
  $pins = Get-FirstLaunchPins
  $inventoryPin = Get-FirstLaunchInventory
  Assert-True ($pins.sourceSha -eq 'bdf54cd4eb6f20e63664c00cf46209a5c941065e') 'candidate source pin'
  Assert-True ($pins.artifact.id -eq '14730062702' -and $pins.artifact.sizeBytes -eq 31988714) 'artifact identity and size pin'
  Assert-True ($pins.package.innerEntryCount -eq 21 -and $pins.package.fileInventoryCount -eq 19 -and $inventoryPin.Count -eq 19) '21 ZIP entries and canonical 19-file inventory pins'
  $pinBytes = Get-FirstLaunchCanonicalInventoryBytes $inventoryPin
  Assert-True ((Get-TestSha256 $pinBytes) -eq $pins.package.canonicalInventorySha256) 'PowerShell canonical 19-entry invoice digest'
  $mutablePins = Get-FirstLaunchPins
  $mutableInventory = Get-FirstLaunchInventory
  $mutablePins.package.innerSha256 = '0' * 64
  $mutablePins.artifact.id = '1'
  $mutableInventory[0].path = 'mutated/path'
  $freshPins = Get-FirstLaunchPins
  $freshInventory = Get-FirstLaunchInventory
  Assert-True ($freshPins.package.innerSha256 -eq $pins.package.innerSha256 -and $freshPins.artifact.id -eq $pins.artifact.id) 'candidate getter returns deep detached copies'
  Assert-True ($freshInventory[0].path -eq $inventoryPin[0].path) 'inventory getter returns deep detached copies'

  $helperModule = Get-Module MorrowFirstLaunchNeutralZipHelpers -All | Select-Object -First 1
  Assert-True ($null -ne $helperModule) 'isolated legacy helper module was imported'
  Assert-True ($helperModule.ExportedFunctions.Keys -contains 'Assert-ZipArchiveSafe' -and
    $helperModule.ExportedFunctions.Keys -contains 'Expand-SafeZipArchive') 'only neutral ZIP entrypoints are exported from the helper module'
  Assert-True ($null -eq (Get-Variable -Name Artifact -Scope Script -ErrorAction SilentlyContinue)) 'legacy Artifact pin is not visible in the caller scope'

  $metadataCandidate = Copy-TestCandidate
  $metadataCandidate.artifact.expiresAtUtc = '2099-12-31T23:59:59.000Z'
  $metadata = [ordered]@{
    id = [long]$metadataCandidate.artifact.id
    name = [string]$metadataCandidate.artifact.name
    expired = $false
    size_in_bytes = [long]$metadataCandidate.artifact.sizeBytes
    digest = [string]$metadataCandidate.artifact.digest
    expires_at = [string]$metadataCandidate.artifact.expiresAtUtc
    workflow_run = [ordered]@{ id = [long]$metadataCandidate.buildRunId; head_sha = [string]$metadataCandidate.sourceSha; head_branch = [string]$metadataCandidate.branch }
  }
  $verifiedMetadata = Assert-PinnedArtifactMetadata $metadata $metadataCandidate
  Assert-True ($verifiedMetadata.artifactId -eq '14730062702' -and $verifiedMetadata.expired -eq $false) 'pinned GitHub metadata acceptance'
  foreach ($mutant in @(
    @{ Field = 'id'; Value = 1 },
    @{ Field = 'name'; Value = 'other-artifact' },
    @{ Field = 'expired'; Value = $true },
    @{ Field = 'expired'; Value = 'false' },
    @{ Field = 'expired'; Value = 0 },
    @{ Field = 'size_in_bytes'; Value = 1 },
    @{ Field = 'digest'; Value = 'sha256:' + ('0' * 64) }
  )) {
    $badMetadata = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
    $badMetadata[$mutant.Field] = $mutant.Value
    Assert-Throws "metadata mutant $($mutant.Field)" { Assert-PinnedArtifactMetadata $badMetadata $metadataCandidate }
  }
  $missingExpired = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  [void]$missingExpired.Remove('expired')
  Assert-Throws 'metadata missing strict expired boolean' { Assert-PinnedArtifactMetadata $missingExpired $metadataCandidate }
  $elapsedMetadata = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  $elapsedMetadata.expires_at = '2020-01-01T00:00:00.000Z'
  Assert-Throws 'metadata elapsed expiry rejected' { Assert-PinnedArtifactMetadata $elapsedMetadata $metadataCandidate }
  $elapsedCandidate = Copy-TestCandidate
  $elapsedCandidate.artifact.expiresAtUtc = '2020-01-01T00:00:00.000Z'
  Assert-Throws 'pinned candidate elapsed expiry rejected' { Assert-FirstLaunchCandidateNotExpired $elapsedCandidate }
  $wrongRun = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $metadata -Depth 8 -Compress) -AsHashtable
  $wrongRun.workflow_run.head_sha = '0' * 40
  Assert-Throws 'metadata source SHA mutant' { Assert-PinnedArtifactMetadata $wrongRun $metadataCandidate }

  $goodBlob = 'https://productionresultssa16.blob.core.windows.net/container/artifact.zip?sv=synthetic&sig=secret'
  Assert-True ((Assert-FirstLaunchBlobUri $goodBlob).Host -eq 'productionresultssa16.blob.core.windows.net') 'official blob redirect host accepted'
  foreach ($badUri in @(
    'http://productionresultssa16.blob.core.windows.net/a?sig=x',
    'https://attacker.example/a?sig=x',
    'https://user@productionresultssa16.blob.core.windows.net/a?sig=x',
    'https://productionresultssa16.blob.core.windows.net:444/a?sig=x',
    'https://productionresultssa16.blob.core.windows.net/a?sig=x#fragment'
  )) { Assert-Throws "redirect URI rejected: $($badUri.Split('?')[0])" { Assert-FirstLaunchBlobUri $badUri } }

  $safeZip = Join-Path $root 'safe.zip'
  New-TestZip $safeZip @(@{ Name = 'safe/file.txt'; Content = 'synthetic bytes' })
  $safeValidation = Assert-FirstLaunchZipPolicy $safeZip 1 15
  Assert-True ($safeValidation.EntryCount -eq 1) 'safe package ZIP path and CRC accepted'

  $traversal = Join-Path $root 'traversal.zip'
  New-TestZip $traversal @(@{ Name = '../outside.txt'; Content = 'no-write' })
  Assert-Throws 'ZIP traversal rejected before expansion' { Assert-FirstLaunchZipPolicy $traversal }
  $absolute = Join-Path $root 'absolute.zip'
  New-TestZip $absolute @(@{ Name = '/outside.txt'; Content = 'no-write' })
  Assert-Throws 'ZIP absolute path rejected before expansion' { Assert-FirstLaunchZipPolicy $absolute }
  $stream = Join-Path $root 'stream.zip'
  New-TestZip $stream @(@{ Name = 'safe/file.txt:alternate'; Content = 'no-write' })
  Assert-Throws 'ZIP alternate data stream rejected' { Assert-FirstLaunchZipPolicy $stream }
  $caseDuplicate = Join-Path $root 'case-duplicate.zip'
  New-TestZip $caseDuplicate @(
    @{ Name = 'DemoVault/one.txt'; Content = 'one' },
    @{ Name = 'demovault/two.txt'; Content = 'two' }
  )
  Assert-Throws 'case-folded ZIP path collision rejected' { Assert-FirstLaunchZipPolicy $caseDuplicate }
  $shortAlias = Join-Path $root 'short-alias.zip'
  New-TestZip $shortAlias @(@{ Name = 'DemoVault/PROGRA~1.txt'; Content = 'alias' })
  Assert-Throws 'Windows 8.3 short-name alias rejected' { Assert-FirstLaunchZipPolicy $shortAlias }
  foreach ($aliasName in @('FOO~10', 'PROGRA~10.txt', 'PROGRA~10/child.txt', 'PROGRA~10/')) {
    $aliasPath = Join-Path $root ('alias-' + [Guid]::NewGuid().ToString('N') + '.zip')
    $aliasEntry = @{ Name = ('DemoVault/' + $aliasName); Content = 'alias' }
    if ($aliasName.EndsWith('/')) { $aliasEntry = @{ Name = ('DemoVault/' + $aliasName); Bytes = [byte[]]@() } }
    New-TestZip $aliasPath @($aliasEntry)
    Assert-Throws "Windows 8.3 short-name alias rejected: $aliasName" { Assert-FirstLaunchZipPolicy $aliasPath }
    $aliasDestination = Join-Path $root ('alias-dest-' + [Guid]::NewGuid().ToString('N'))
    Assert-Throws "short-name alias rejected before expansion: $aliasName" { Expand-FirstLaunchSafeZipArchive $aliasPath $aliasDestination 0 -1 }
    Assert-True (-not [IO.Directory]::Exists($aliasDestination)) "invalid alias creates no extraction root: $aliasName"
  }
  $outerAlias = Join-Path $root 'outer-alias.zip'
  New-TestZip $outerAlias @(@{ Name = 'art~10.zip'; Content = 'inner' })
  Assert-Throws 'outer ZIP short-name alias rejected' { Assert-FirstLaunchZipPolicy $outerAlias }
  $outerAliasDestination = Join-Path $root 'outer-alias-dest'
  Assert-Throws 'outer ZIP alias rejected before extraction' { Expand-FirstLaunchSafeZipArchive $outerAlias $outerAliasDestination 1 5 }
  Assert-True (-not [IO.Directory]::Exists($outerAliasDestination)) 'outer ZIP alias creates no extraction root'
  $nonCanonicalUnicode = Join-Path $root 'noncanonical-unicode.zip'
  $nfcSegment = "Caf$([char]0x00E9).md"
  $nfdSegment = "Cafe$([char]0x0301).md"
  $nfcPath = 'DemoVault/' + $nfcSegment
  $nfdPath = 'DemoVault/' + $nfdSegment
  Assert-True ([string]::Equals($nfdPath.Normalize([Text.NormalizationForm]::FormC), $nfcPath, [StringComparison]::Ordinal) -and
    -not [string]::Equals($nfdPath, $nfcPath, [StringComparison]::Ordinal)) 'NFD and NFC paths are distinct ordinal strings before normalization'
  Assert-Throws 'direct path guard rejects NFD by ordinal comparison' { Get-FirstLaunchZipPathPolicy $nfdPath $false }
  New-TestZip $nonCanonicalUnicode @(@{ Name = $nfdPath; Content = 'unicode' })
  Assert-Throws 'non-NFC Unicode path rejected' { Assert-FirstLaunchZipPolicy $nonCanonicalUnicode }
  $canonicalCollision = Join-Path $root 'case-collision.zip'
  New-TestZip $canonicalCollision @(
    @{ Name = 'DemoVault/Readme.md'; Content = 'one' },
    @{ Name = 'demovault/readme.MD'; Content = 'two' }
  )
  Assert-Throws 'OrdinalIgnoreCase path collision rejected' { Assert-FirstLaunchZipPolicy $canonicalCollision }

  $invalidZipPathIndex = 0
  foreach ($invalidCharacter in @('<', '>', '"', '|', '?', '*', [char]0x0001)) {
    $innerBadPath = Join-Path $root ('invalid-inner-' + $invalidZipPathIndex + '.zip')
    New-TestZip $innerBadPath @(@{ Name = ('DemoVault/bad' + $invalidCharacter + '.txt'); Content = 'bad' })
    Assert-Throws "inner ZIP rejects Windows-invalid path char U+$('{0:X4}' -f [int][char]$invalidCharacter)" { Assert-FirstLaunchZipPolicy $innerBadPath }
    $innerBadDestination = Join-Path $root ('invalid-inner-dest-' + $invalidZipPathIndex)
    Assert-Throws "inner ZIP invalid path rejected before extraction $invalidZipPathIndex" { Expand-FirstLaunchSafeZipArchive $innerBadPath $innerBadDestination 0 -1 }
    Assert-True (-not [IO.Directory]::Exists($innerBadDestination)) "inner ZIP invalid path creates no root $invalidZipPathIndex"

    $outerBadPath = Join-Path $root ('invalid-outer-' + $invalidZipPathIndex + '.zip')
    New-TestZip $outerBadPath @(@{ Name = ('artifact' + $invalidCharacter + '.zip'); Content = 'bad' })
    Assert-Throws "outer ZIP rejects Windows-invalid path char U+$('{0:X4}' -f [int][char]$invalidCharacter)" { Assert-FirstLaunchZipPolicy $outerBadPath }
    $invalidZipPathIndex++
  }

  $readOnlyTree = Join-Path $root 'readonly-package-tree'
  $readOnlyTarget = Join-Path $root 'readonly-link-target'
  [void][IO.Directory]::CreateDirectory((Join-Path $readOnlyTree 'safe'))
  [void][IO.Directory]::CreateDirectory($readOnlyTarget)
  [IO.File]::WriteAllText((Join-Path $readOnlyTree 'safe/keep.txt'), 'read-only tree fixture')
  $linkPath = Join-Path $readOnlyTree 'empty-link'
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [void](New-Item -ItemType Junction -Path $linkPath -Target $readOnlyTarget -ErrorAction Stop)
  } else {
    [void][IO.Directory]::CreateSymbolicLink($linkPath, $readOnlyTarget)
  }
  [IO.File]::SetAttributes($readOnlyTree, [IO.FileAttributes]::ReadOnly)
  Assert-True (([IO.File]::GetAttributes($linkPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'empty directory link is identified as reparse before scan'
  Assert-Throws 'bounded top-down inventory rejects empty symlink before descent in read-only root' {
    Get-FirstLaunchPackageTree $readOnlyTree @('safe/keep.txt')
  }
  $plainTree = Join-Path $root 'plain-package-tree'
  [void][IO.Directory]::CreateDirectory((Join-Path $plainTree 'safe'))
  [void][IO.Directory]::CreateDirectory((Join-Path $plainTree 'empty-extra'))
  [IO.File]::WriteAllText((Join-Path $plainTree 'safe/keep.txt'), 'plain tree fixture')
  Assert-Throws 'inventory rejects an unexpected empty directory path' { Get-FirstLaunchPackageTree $plainTree @('safe/keep.txt') }
  Assert-Throws 'inventory rejects a missing expected file path' { Get-FirstLaunchPackageTree $plainTree @('safe/keep.txt', 'missing.txt') }
  $oversizedExpectedTree = @(1..1025 | ForEach-Object { 'file-' + $_ + '.txt' })
  Assert-Throws 'inventory expected tree has a bounded directory and file count' { Get-FirstLaunchPackageTree $plainTree $oversizedExpectedTree }
  $symlink = Join-Path $root 'symlink.zip'
  New-TestZip $symlink @(@{ Name = 'link.txt'; Content = 'target'; ExternalAttributes = -1577123840 })
  Assert-Throws 'ZIP reparse/symlink entry rejected' { Assert-FirstLaunchZipPolicy $symlink }
  $badCrc = Join-Path $root 'bad-crc.zip'
  New-TestZip $badCrc @(@{ Name = 'data.bin'; Content = 'bytes that will be corrupted' })
  Corrupt-TestZipPayload $badCrc
  Assert-Throws 'ZIP CRC mismatch rejected' { Assert-FirstLaunchZipPolicy $badCrc }

  $fixture = New-TestPackageFixture $root
  $stage = Join-Path $root 'verified-stage'
  $liveOverrideStage = Join-Path $root 'live-override-stage'
  $pinnedTransportStage = Join-Path $root 'pinned-transport-stage'
  $pinnedTransport = New-TestTransport $fixture
  Assert-Throws 'hermetic transport requires explicit synthetic candidate and inventory' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $pinnedTransportStage $pins $inventoryPin $pinnedTransport
  }
  Assert-True ($script:transportCalls.Count -eq 0 -and -not [IO.Directory]::Exists($pinnedTransportStage)) 'pinned candidate cannot use offline transport path or create stage'
  Assert-Throws 'live network path refuses test candidate overrides' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $liveOverrideStage $fixture.candidate $fixture.expectedInventory
  }
  Assert-True (-not [IO.Directory]::Exists($liveOverrideStage)) 'live candidate override is rejected before staging or network access'
  $expiredStage = Join-Path $root 'expired-candidate-stage'
  $expiredCandidate = Copy-FirstLaunchValue $fixture.candidate
  $expiredCandidate.artifact.expiresAtUtc = '2020-01-01T00:00:00.000Z'
  $expiredTransport = New-TestTransport $fixture
  Assert-Throws 'expired package candidate rejected before transport or stage creation' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $expiredStage $expiredCandidate $fixture.expectedInventory $expiredTransport
  }
  Assert-True ($script:transportCalls.Count -eq 0 -and -not [IO.Directory]::Exists($expiredStage)) 'expired candidate cannot request or publish bytes'
  $livePinnedStage = Join-Path $root 'live-pinned-stage'
  Assert-Throws 'live caller snapshots are accepted structurally then blocked at local runner stage boundary' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $livePinnedStage (Get-FirstLaunchPins) (Get-FirstLaunchInventory)
  }
  Assert-True (-not [IO.Directory]::Exists($livePinnedStage)) 'live stage boundary rejects an unsafe platform/path before network or stage creation'
  $successTransport = New-TestTransport $fixture
  $verified = Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $stage $fixture.candidate $fixture.expectedInventory $successTransport
  Assert-True ($verified.receipt.schema -eq 'morrow.e003.g23.verified-package.v1' -and $verified.receipt.status -eq 'verified') 'verified package receipt schema'
  Assert-True ($verified.receipt.packageInventory.Count -eq 19 -and $verified.receipt.packageInventorySha256 -eq $fixture.candidate.package.canonicalInventorySha256) 'verified package forwards exact inventory and digest'
  Assert-True ($verified.receipt.noLaunch.appLaunched -eq $false -and $verified.receipt.noLaunch.launcherExecuted -eq $false -and
    $verified.receipt.noLaunch.driverServiceStarted -eq $false -and $verified.receipt.noLaunch.guiTested -eq $false) 'receipt explicitly records no launcher, app, GUI, or driver execution'
  Assert-True ($script:transportCalls.Count -eq 3) 'exactly three GET requests used'
  Assert-True ($script:transportCalls[0].uri -match '^https://api\.github\.com/repos/hodeliun/Morrow/actions/artifacts/14730062702$' -and
    $script:transportCalls[0].headers.Authorization -eq 'Bearer synthetic-api-token') 'metadata request uses fixed API endpoint and bearer'
  Assert-True ($script:transportCalls[1].uri -match '/actions/artifacts/14730062702/zip$' -and
    $script:transportCalls[1].headers.Authorization -eq 'Bearer synthetic-api-token') 'ZIP redirect request uses fixed API endpoint and bearer'
  Assert-True ($script:transportCalls[2].uri -match '^https://productionresultssa16\.blob\.core\.windows\.net/' -and
    -not $script:transportCalls[2].headers.Contains('Authorization')) 'blob request sends no bearer to signed storage'
  Assert-True (@($script:transportCalls | Where-Object { $_.allowAutoRedirect -ne $false }).Count -eq 0) 'redirects are disabled on all requests'
  Assert-True ($script:transportCalls[2].maxBytes -eq $fixture.candidate.artifact.sizeBytes -and $script:transportCalls[2].timeoutMs -le 120000) 'blob request has byte and deadline limits'
  $receiptText = [IO.File]::ReadAllText($verified.receiptPath)
  Assert-True (-not $receiptText.Contains('synthetic-api-token') -and -not $receiptText.Contains('FAKE_SAS_MUST_NOT_LEAK')) 'receipt excludes API token and signed redirect query'
  Assert-True ([IO.File]::Exists((Join-Path $verified.packageRoot 'morrow.exe')) -and [IO.File]::Exists((Join-Path $verified.packageRoot 'windows-launch.ps1'))) 'verified synthetic package extracted without launching executable or launcher'

  $occupiedPart = Join-Path $root 'occupied.part'
  [IO.File]::WriteAllText($occupiedPart, 'do not replace', [Text.UTF8Encoding]::new($false))
  $occupiedPartTransport = { param($Request) [pscustomobject]@{ StatusCode = 200; Headers = @{}; BodyBytes = [Text.Encoding]::UTF8.GetBytes('replacement') } }.GetNewClosure()
  Assert-Throws 'HTTP test body uses create-new semantics for an occupied partial path' {
    Invoke-FirstLaunchHttpGet ([uri]$goodBlob) @{} 1000 64 $occupiedPart $occupiedPartTransport
  }
  Assert-True ([IO.File]::ReadAllText($occupiedPart) -ceq 'do not replace') 'occupied .part file content remains unchanged'

  $receiptCollisionStage = Join-Path $root 'receipt-collision-stage'
  $receiptCollisionState = @{ receiptPath = $null }
  $receiptCollisionBaseTransport = New-TestTransport $fixture
  $receiptCollisionTransport = {
    param($Request)
    if ($Request.destination) {
      $downloadsPath = [IO.Path]::GetDirectoryName([string]$Request.destination)
      $stagePath = [IO.Path]::GetDirectoryName($downloadsPath)
      $receiptCollisionState.receiptPath = Join-Path $stagePath 'verified-package.json'
      [IO.File]::WriteAllText($receiptCollisionState.receiptPath, 'preserve existing receipt', [Text.UTF8Encoding]::new($false))
    }
    & $receiptCollisionBaseTransport $Request
  }.GetNewClosure()
  Assert-Throws 'verified-package receipt uses create-new semantics' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $receiptCollisionStage $fixture.candidate $fixture.expectedInventory $receiptCollisionTransport
  }
  Assert-True ([IO.File]::ReadAllText($receiptCollisionState.receiptPath) -ceq 'preserve existing receipt') 'receipt collision does not overwrite existing bytes'

  foreach ($mode in @('metadata-status', 'redirect-status', 'redirect-host', 'blob-status', 'blob-length', 'blob-digest')) {
    $badStage = Join-Path $root ('failed-' + $mode)
    $badTransport = New-TestTransport $fixture $mode
    Assert-Throws "download transport mutant $mode" {
      Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $badStage $fixture.candidate $fixture.expectedInventory $badTransport
    }
    Assert-True (-not [IO.File]::Exists((Join-Path $badStage 'downloads/artifact.zip'))) "failed $mode does not publish an artifact file"
    $partCount = 0
    if ([IO.Directory]::Exists((Join-Path $badStage 'downloads'))) {
      $partCount = @([IO.Directory]::EnumerateFiles((Join-Path $badStage 'downloads'), '*.part')).Count
    }
    Assert-True ($partCount -eq 0) "failed $mode removes partial bytes"
  }

  $secretStage = Join-Path $root 'transport-secret-stage'
  $secretTransport = New-TestTransport $fixture 'transport-secret'
  Assert-ThrowsWithoutSecrets 'raw injected transport exception is replaced at the boundary' {
    Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $secretStage $fixture.candidate $fixture.expectedInventory $secretTransport
  } @('synthetic-api-token', 'FAKE_SAS_MUST_NOT_LEAK', 'sig=secret', 'https://host.invalid')

  $tamperedRoot = Join-Path $root 'tampered-package'
  $tamperedStage = Join-Path $root 'tampered-stage'
  $tamperedFixture = New-TestPackageFixture $tamperedRoot
  $tamperedTransport = New-TestTransport $tamperedFixture
  $tampered = Get-FirstLaunchVerifiedPackage 'synthetic-api-token' $tamperedStage $tamperedFixture.candidate $tamperedFixture.expectedInventory $tamperedTransport
  $tamperedFile = Join-Path $tampered.packageRoot 'DemoVault/Checklist.md'
  [IO.File]::WriteAllText($tamperedFile, 'tampered', [Text.UTF8Encoding]::new($false))
  Assert-Throws 'mutated extracted file hash rejected' { Assert-FirstLaunchPackage $tampered.packageRoot $tampered.innerZipPath $tamperedFixture.candidate $tamperedFixture.expectedInventory }
  $extraFile = Join-Path $tampered.packageRoot 'unlisted.txt'
  [IO.File]::WriteAllText($extraFile, 'extra', [Text.UTF8Encoding]::new($false))
  Assert-Throws 'extra package file rejected' { Assert-FirstLaunchPackageInventory $tampered.packageRoot $tamperedFixture.candidate $tamperedFixture.expectedInventory }

  Write-Output "windows-first-launch-preflight passed $script:assertionCount assertions."
} finally {
  if ($null -ne $readOnlyTree -and [IO.Directory]::Exists($readOnlyTree)) {
    $attributes = [IO.File]::GetAttributes($readOnlyTree)
    [IO.File]::SetAttributes($readOnlyTree, $attributes -band (-bnot [IO.FileAttributes]::ReadOnly))
  }
  if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
