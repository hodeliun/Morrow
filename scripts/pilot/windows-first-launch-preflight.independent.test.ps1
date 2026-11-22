[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $EvidenceRoot,
  [Parameter(Mandatory = $true)][string] $PinnedArtifactPath,
  [string] $ModulePath = (Join-Path $PSScriptRoot 'windows-first-launch-preflight.ps1')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:Cases = [System.Collections.Generic.List[string]]::new()
$script:SkippedCases = [System.Collections.Generic.List[string]]::new()
$script:Failures = [System.Collections.Generic.List[object]]::new()
$script:Status = 'failed'
$script:OuterSha256 = $null
$script:InnerSha256 = $null
$script:SourceSha256 = $null
$script:LegacySha256 = $null

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SanitizedFailure {
  param([object] $ErrorRecord)
  $message = ''
  if ($null -ne $ErrorRecord -and $null -ne $ErrorRecord.Exception) {
    $message = [string]$ErrorRecord.Exception.Message
  }
  $message = [regex]::Replace($message, '(?i)(authorization\s*:\s*bearer\s+)[^\s]+', '$1[REDACTED]')
  $message = [regex]::Replace($message, '(?i)(https?://[^\s?]+)\?[^\s]+', '$1?[REDACTED]')
  $message = [regex]::Replace($message, '(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b', '[REDACTED]')
  return $message
}

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param([object] $Actual, [object] $Expected, [string] $Message)
  if ($null -eq $Actual -or $null -eq $Expected) {
    if (-not [object]::ReferenceEquals($Actual, $Expected)) { throw $Message }
    return
  }
  if ([string]$Actual -cne [string]$Expected) { throw $Message }
}

function Assert-Throws {
  param(
    [Parameter(Mandatory = $true)][scriptblock] $Action,
    [string] $ExpectedText
  )
  $thrown = $false
  try { & $Action | Out-Null }
  catch {
    $thrown = $true
    if (-not [string]::IsNullOrEmpty($ExpectedText) -and
        -not ([string]$_.Exception.Message).Contains($ExpectedText, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'A rejection produced a different bounded failure.'
    }
  }
  if (-not $thrown) { throw 'An invalid input was accepted.' }
}

function Invoke-Case {
  param([string] $Name, [scriptblock] $Action)
  try {
    & $Action | Out-Null
    $script:Cases.Add($Name)
  } catch {
    $script:Failures.Add([pscustomobject]@{ case = $Name; message = (Get-SanitizedFailure $_) })
  }
}

function New-Response {
  param([int] $StatusCode, [byte[]] $BodyBytes = [byte[]]@(), [System.Collections.IDictionary] $Headers = [ordered]@{})
  return [pscustomobject]@{ StatusCode = $StatusCode; Headers = $Headers; BodyBytes = $BodyBytes }
}

function New-TransportFixture {
  param(
    [Parameter(Mandatory = $true)][object] $Candidate,
    [Parameter(Mandatory = $true)][byte[]] $ArtifactBytes,
    [string] $Scenario = 'success',
    [object[]] $ExpectedInventory
  )
  $token = 'independent-test-token-never-for-output-252'
  $sas = 'independent-test-sas-never-for-output-252'
  $metadata = [ordered]@{
    id = [string]$Candidate.artifact.id
    name = [string]$Candidate.artifact.name
    expired = $false
    size_in_bytes = [long]$Candidate.artifact.sizeBytes
    digest = [string]$Candidate.artifact.digest
    workflow_run = [ordered]@{
      id = [string]$Candidate.buildRunId
      head_sha = [string]$Candidate.sourceSha
      head_branch = [string]$Candidate.branch
    }
    expires_at = [string]$Candidate.artifact.expiresAtUtc
  }
  switch ($Scenario) {
    'metadataMismatch' { $metadata.id = '1' }
    'metadataWrongSize' { $metadata.size_in_bytes = [long]$Candidate.artifact.sizeBytes + 1 }
    'metadataExpired' { $metadata.expired = $true }
    'metadataExpiredStringFalse' { $metadata.expired = 'false' }
  }
  $metadataText = ConvertTo-Json -InputObject $metadata -Depth 6 -Compress
  $metadataBytes = [Text.UTF8Encoding]::new($false).GetBytes($metadataText)
  if ($Scenario -eq 'metadataMalformed') { $metadataBytes = [Text.UTF8Encoding]::new($false).GetBytes('{bad json') }
  if ($Scenario -eq 'metadataOversize') { $metadataBytes = [byte[]]::new(1048577) }
  $blobBytes = $ArtifactBytes
  if ($Scenario -eq 'blobWrongHash') {
    $blobBytes = [byte[]]::new($ArtifactBytes.Length)
    [Array]::Copy($ArtifactBytes, $blobBytes, $ArtifactBytes.Length)
    $blobBytes[0] = [byte]($blobBytes[0] -bxor 1)
  }
  $calls = [System.Collections.ArrayList]::new()
  $state = [pscustomobject]@{
    Calls = $calls
    Candidate = $Candidate
    Token = $token
    Sas = $sas
    MetadataBytes = $metadataBytes
    BlobBytes = $blobBytes
    Scenario = $Scenario
    ExpectedInventory = $ExpectedInventory
  }
  $transport = {
    param($request)
    [void]$state.Calls.Add($request)
    if ($state.Scenario -eq 'mutateCallerOnFirstRequest' -and $state.Calls.Count -eq 1) {
      $state.Candidate.package.innerName = 'mutated-by-fixture.zip'
      $state.Candidate.package.innerSha256 = ('0' * 64)
      $state.ExpectedInventory[0].sha256 = ('0' * 64)
    }
    if ($request.allowAutoRedirect -ne $false) { throw 'Synthetic guard: redirect must remain disabled.' }
    $uri = [uri]$request.uri
    if ($uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort) { throw 'Synthetic guard: HTTPS default port required.' }
    $auth = $null
    foreach ($key in $request.headers.Keys) {
      if ([string]::Equals([string]$key, 'Authorization', [StringComparison]::OrdinalIgnoreCase)) {
        $auth = [string]$request.headers[$key]
      }
    }
    if ($state.Scenario -eq 'throwSecret') {
      throw ('Authorization: Bearer ' + $state.Token + ' https://example.invalid/download?sig=' + $state.Sas)
    }
    $metadataPath = '/repos/' + [string]$state.Candidate.repository + '/actions/artifacts/' + [string]$state.Candidate.artifact.id
    if ($uri.Host -ceq 'api.github.com' -and $uri.AbsolutePath -ceq $metadataPath) {
      if ($auth -cne ('Bearer ' + $state.Token)) { throw 'Synthetic guard: metadata authorization missing.' }
      if ($request.maxBytes -ne 1048576) { throw 'Synthetic guard: metadata byte limit changed.' }
      if ($request.timeoutMs -le 0 -or $request.timeoutMs -gt 30000) { throw 'Synthetic guard: metadata timeout is unbounded.' }
      if ($state.Scenario -eq 'metadataOversize') {
        return (New-Response 200 $state.MetadataBytes ([ordered]@{ 'Content-Length' = '1048577' }))
      }
      if ($state.Scenario -eq 'metadataWrongContentLength') {
        return (New-Response 200 $state.MetadataBytes ([ordered]@{ 'Content-Length' = '1' }))
      }
      return (New-Response 200 $state.MetadataBytes ([ordered]@{ 'Content-Length' = [string]$state.MetadataBytes.Length }))
    }
    if ($uri.Host -ceq 'api.github.com' -and $uri.AbsolutePath -ceq ($metadataPath + '/zip')) {
      if ($auth -cne ('Bearer ' + $state.Token)) { throw 'Synthetic guard: redirect authorization missing.' }
      if ($request.maxBytes -ne 16384) { throw 'Synthetic guard: redirect byte limit changed.' }
      if ($request.timeoutMs -le 0 -or $request.timeoutMs -gt 30000) { throw 'Synthetic guard: redirect timeout is unbounded.' }
      $location = 'https://productionresultssa16.blob.core.windows.net/artifacts/pinned.zip?sig=' + $state.Sas
      if ($state.Scenario -eq 'redirectWrongHost') { $location = 'https://evil.example/artifacts/pinned.zip?sig=' + $state.Sas }
      if ($state.Scenario -eq 'redirectMissingLocation') {
        return (New-Response 302 ([byte[]]@()) ([ordered]@{}))
      }
      return (New-Response 302 ([byte[]]@()) ([ordered]@{ Location = $location; 'Content-Length' = '0' }))
    }
    if ($uri.Host -match '^productionresultssa[0-9]+\.blob\.core\.windows\.net$') {
      if ($null -ne $auth) { throw 'Synthetic guard: bearer authorization must not reach blob storage.' }
      if ($uri.Query -notmatch 'sig=' + [regex]::Escape($state.Sas)) { throw 'Synthetic guard: synthetic signed query is absent.' }
      if ($request.maxBytes -ne [long]$state.Candidate.artifact.sizeBytes) { throw 'Synthetic guard: blob byte limit differs from pin.' }
      if ($request.timeoutMs -le 0 -or $request.timeoutMs -gt 120000) { throw 'Synthetic guard: blob timeout is unbounded.' }
      if ([string]::IsNullOrEmpty([string]$request.destination) -or
          -not [string]$request.destination.EndsWith('.part', [StringComparison]::Ordinal)) {
        throw 'Synthetic guard: blob must write to a private temporary part.'
      }
      $contentLength = [string]$state.BlobBytes.Length
      if ($state.Scenario -eq 'blobWrongContentLength') { $contentLength = [string]($state.BlobBytes.Length + 1) }
      return (New-Response 200 $state.BlobBytes ([ordered]@{ 'Content-Length' = $contentLength; 'Content-Type' = 'application/octet-stream' }))
    }
    throw 'Synthetic guard: unexpected HTTP destination.'
  }.GetNewClosure()
  return [pscustomobject]@{ Callback = $transport; Calls = $calls; Token = $token; Sas = $sas }
}

function New-SyntheticZip {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string[]] $EntryNames
  )
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = $null
  try {
    $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($entryName in $EntryNames) {
      $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::NoCompression)
      if (-not $entryName.EndsWith('/')) {
        $stream = $entry.Open()
        try { $payload = [byte[]](0x41, 0x42, 0x43); $stream.Write($payload, 0, $payload.Length) }
        finally { $stream.Dispose() }
      }
    }
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    $file.Dispose()
  }
}

function New-SyntheticZipWithPayload {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $EntryName,
    [Parameter(Mandatory = $true)][byte[]] $Payload
  )
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = $null
  try {
    $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Create, $true)
    $entry = $archive.CreateEntry($EntryName, [IO.Compression.CompressionLevel]::NoCompression)
    $stream = $entry.Open()
    try { $stream.Write($Payload, 0, $Payload.Length) }
    finally { $stream.Dispose() }
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    $file.Dispose()
  }
}

function Invoke-VerifiedPackageFailure {
  param(
    [object] $Candidate,
    [byte[]] $ArtifactBytes,
    [string] $Scenario,
    [string] $StageRoot
  )
  $transport = New-TransportFixture $Candidate $ArtifactBytes $Scenario
  Assert-Throws {
    Get-FirstLaunchVerifiedPackage -Token $transport.Token -StageRoot $StageRoot -Candidate $Candidate -ExpectedInventory $script:TestInventory -Transport $transport.Callback | Out-Null
  }
  return $transport
}

function New-TestCandidate {
  $copy = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $script:Pin -Depth 20 -Compress) -AsHashtable -DateKind String
  $copy.independentFixtureMarker = 'hermetic-test-only'
  return $copy
}

function New-TestInventory {
  return (ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $script:PinInventory -Depth 20 -Compress) -AsHashtable -DateKind String)
}

$evidencePath = [IO.Path]::GetFullPath($EvidenceRoot)
if ([IO.Directory]::Exists($evidencePath) -or [IO.File]::Exists($evidencePath)) {
  throw 'EvidenceRoot must be a new path.'
}
$evidenceParent = [IO.Path]::GetDirectoryName($evidencePath)
if ([string]::IsNullOrWhiteSpace($evidenceParent) -or -not [IO.Directory]::Exists($evidenceParent)) {
  throw 'EvidenceRoot parent must already exist.'
}
[void][IO.Directory]::CreateDirectory($evidencePath)

try {
  if (-not [IO.File]::Exists($ModulePath)) { throw 'Frozen production module is missing.' }
  $legacyPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ModulePath))) 'windows-preflight.ps1'
  if (-not [IO.File]::Exists($legacyPath)) { throw 'Pinned legacy helper is missing beside the production module.' }
  if (-not [IO.File]::Exists($PinnedArtifactPath)) { throw 'Offline pinned artifact bytes are missing.' }

  $script:SourceSha256 = Get-FileSha256 $ModulePath
  $script:LegacySha256 = Get-FileSha256 $legacyPath
  Assert-Equal $script:SourceSha256 'd53404375f8376b7db533d3fbee56cc14e9a08b5fe4602c43fda58888b2a8f9a' 'Frozen production source hash differs.'
  Assert-Equal $script:LegacySha256 'a804794415184a80603f8d45419ec8de6f8b77b4bcc330874fe259168f9fbc65' 'Pinned neutral helper source hash differs.'

  . $ModulePath -LibraryOnly
  $pin = Get-FirstLaunchPins
  $inventory = Get-FirstLaunchInventory
  $script:Pin = $pin
  $script:PinInventory = $inventory
  $script:TestCandidate = New-TestCandidate
  $script:TestInventory = New-TestInventory
  $script:OuterSha256 = Get-FileSha256 $PinnedArtifactPath
  $outerInfo = Get-Item -LiteralPath $PinnedArtifactPath
  Assert-Equal $script:OuterSha256 ([string]$pin.package.outerSha256) 'Offline artifact SHA-256 differs from the compiled pin.'
  Assert-Equal ([long]$outerInfo.Length) ([long]$pin.artifact.sizeBytes) 'Offline artifact size differs from the compiled pin.'

  Invoke-Case 'source-and-pins' {
    Assert-Equal ([string]$pin.repository) 'hodeliun/Morrow' 'Repository pin differs.'
    Assert-Equal ([string]$pin.buildRunId) '44961916968' 'Build run pin differs.'
    Assert-Equal ([string]$pin.artifact.id) '14730062702' 'Artifact id pin differs.'
    Assert-Equal $inventory.Count 19 'Pinned inventory count differs.'
    Assert-Equal ([string]$pin.package.canonicalInventorySha256) 'd8d4e6cb1a419cc342f9f63f43c5931cc1d3feb6041a4a1f7d104167104b9baf' 'Canonical inventory digest differs.'
  }

  Invoke-Case 'public-pin-getters-return-deep-detached-copies' {
    $firstCandidate = Get-FirstLaunchPins
    $secondCandidate = Get-FirstLaunchPins
    Assert-True (-not [object]::ReferenceEquals($firstCandidate, $secondCandidate)) 'Pin getter reused the root object.'
    Assert-True (-not [object]::ReferenceEquals($firstCandidate.package, $secondCandidate.package)) 'Pin getter reused a nested package object.'
    $firstCandidate.package.launcherSha256 = ('0' * 64)
    $firstCandidate.artifact.name = 'mutated-by-caller'
    Assert-Equal $secondCandidate.package.launcherSha256 ([string]$pin.package.launcherSha256) 'Mutating a returned pin changed another getter value.'
    Assert-Equal (Get-FirstLaunchPins).artifact.name ([string]$pin.artifact.name) 'Mutating a returned pin changed internal pin state.'

    $firstInventory = Get-FirstLaunchInventory
    $secondInventory = Get-FirstLaunchInventory
    Assert-True (-not [object]::ReferenceEquals($firstInventory, $secondInventory)) 'Inventory getter reused the array.'
    Assert-True (-not [object]::ReferenceEquals($firstInventory[0], $secondInventory[0])) 'Inventory getter reused a nested entry.'
    $firstInventory[0].sha256 = ('0' * 64)
    $firstInventory[0].path = 'mutated-by-caller'
    Assert-Equal $secondInventory[0].path ([string]$inventory[0].path) 'Mutating a returned inventory changed another getter value.'
    $freshInventory = Get-FirstLaunchInventory
    Assert-Equal $freshInventory[0].sha256 ([string]$inventory[0].sha256) 'Mutating a returned inventory changed internal pin state.'
  }

  Invoke-Case 'offline-pinned-outer-and-inner-zip' {
    $outerPolicy = Assert-FirstLaunchZipPolicy -ArchivePath $PinnedArtifactPath -ExpectedEntryCount 1 -ExpectedTotalBytes ([long]$pin.package.innerSizeBytes)
    Assert-Equal $outerPolicy.EntryCount 1 'Pinned outer ZIP entry count differs.'
    Assert-Equal $outerPolicy.TotalUncompressedBytes ([long]$pin.package.innerSizeBytes) 'Pinned outer ZIP byte total differs.'
    Assert-Equal ([string]$outerPolicy.Entries[0].path) ([string]$pin.package.innerName) 'Pinned outer ZIP contains an unexpected name.'
    $evidenceInner = Join-Path $evidencePath 'verified-inner-package.zip'
    $outerStream = [IO.File]::OpenRead($PinnedArtifactPath)
    $outerArchive = [IO.Compression.ZipArchive]::new($outerStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
      $matches = @($outerArchive.Entries | Where-Object { $_.FullName -ceq [string]$pin.package.innerName })
      Assert-Equal $matches.Count 1 'Pinned outer ZIP does not have exactly one named inner archive.'
      $input = $matches[0].Open()
      $output = [IO.File]::Open($evidenceInner, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $input.CopyTo($output); $output.Flush($true) }
      finally { $output.Dispose(); $input.Dispose() }
    } finally { $outerArchive.Dispose() }
    $script:InnerSha256 = Get-FileSha256 $evidenceInner
    Assert-Equal $script:InnerSha256 ([string]$pin.package.innerSha256) 'Offline inner ZIP SHA-256 differs from the compiled pin.'
    Assert-Equal (Get-Item -LiteralPath $evidenceInner).Length ([long]$pin.package.innerSizeBytes) 'Offline inner ZIP size differs from the compiled pin.'
    $innerPolicy = Assert-FirstLaunchZipPolicy -ArchivePath $evidenceInner -ExpectedEntryCount ([int]$pin.package.innerEntryCount) -ExpectedTotalBytes ([long]$pin.package.innerTotalBytes)
    Assert-Equal $innerPolicy.EntryCount 21 'Pinned inner ZIP entry count differs.'
    Assert-Equal $innerPolicy.TotalUncompressedBytes ([long]$pin.package.innerTotalBytes) 'Pinned inner ZIP byte total differs.'
  }

  $artifactBytes = [IO.File]::ReadAllBytes($PinnedArtifactPath)
  $successStage = Join-Path $evidencePath 'successful-stage'
  $successCandidate = New-TestCandidate
  $successInventory = New-TestInventory
  $successTransport = New-TransportFixture $successCandidate $artifactBytes 'mutateCallerOnFirstRequest' $successInventory
  Invoke-Case 'three-get-offline-transaction-and-receipt' {
    $script:SuccessfulResult = Get-FirstLaunchVerifiedPackage -Token $successTransport.Token -StageRoot $successStage -Candidate $successCandidate -ExpectedInventory $successInventory -Transport $successTransport.Callback
    Assert-Equal $successCandidate.package.innerName 'mutated-by-fixture.zip' 'Fixture did not mutate the caller candidate after entry.'
    Assert-Equal $successInventory[0].sha256 ('0' * 64) 'Fixture did not mutate the caller inventory after entry.'
    Assert-Equal $successTransport.Calls.Count 3 'The transaction did not use exactly three GET requests.'
    $metadataRequest = $successTransport.Calls[0]
    $redirectRequest = $successTransport.Calls[1]
    $blobRequest = $successTransport.Calls[2]
    Assert-True ($metadataRequest.uri -match '^https://api\.github\.com/repos/hodeliun/Morrow/actions/artifacts/14730062702$') 'Metadata URL differs from pin.'
    Assert-True ($redirectRequest.uri -match '/14730062702/zip$') 'Redirect URL differs from pin.'
    Assert-True ($blobRequest.uri -match '^https://productionresultssa16\.blob\.core\.windows\.net/') 'Blob host differs from allowlist.'
    Assert-Equal $metadataRequest.allowAutoRedirect $false 'Metadata redirects must be disabled.'
    Assert-Equal $redirectRequest.allowAutoRedirect $false 'Artifact redirects must be disabled.'
    Assert-Equal $blobRequest.allowAutoRedirect $false 'Blob redirects must be disabled.'
    Assert-Equal $metadataRequest.headers.Authorization ('Bearer ' + $successTransport.Token) 'Metadata must carry the synthetic token.'
    Assert-Equal $redirectRequest.headers.Authorization ('Bearer ' + $successTransport.Token) 'The API redirect request must carry the synthetic token.'
    Assert-True (-not $blobRequest.headers.Contains('Authorization')) 'Bearer authorization was forwarded to blob storage.'
    Assert-Equal $metadataRequest.maxBytes 1048576 'Metadata byte cap differs.'
    Assert-Equal $redirectRequest.maxBytes 16384 'Redirect byte cap differs.'
    Assert-Equal $blobRequest.maxBytes ([long]$pin.artifact.sizeBytes) 'Blob byte cap differs.'
    Assert-True ($metadataRequest.timeoutMs -gt 0 -and $metadataRequest.timeoutMs -le 30000) 'Metadata request timeout is not bounded.'
    Assert-True ($redirectRequest.timeoutMs -gt 0 -and $redirectRequest.timeoutMs -le 30000) 'Redirect request timeout is not bounded.'
    Assert-True ($blobRequest.timeoutMs -gt 0 -and $blobRequest.timeoutMs -le 120000) 'Blob request timeout is not bounded.'
    Assert-True ($blobRequest.destination.EndsWith('.part', [StringComparison]::Ordinal)) 'Blob response was not written to a private part file.'
    $receipt = $script:SuccessfulResult.receipt
    Assert-Equal $receipt.schema 'morrow.e003.g23.verified-package.v1' 'Verified package receipt schema differs.'
    Assert-Equal $receipt.status 'verified' 'Verified package receipt status differs.'
    Assert-Equal $receipt.artifact.id ([string]$pin.artifact.id) 'Receipt artifact identity differs.'
    Assert-Equal $receipt.outerArchive.sha256 ([string]$pin.package.outerSha256) 'Receipt outer ZIP hash differs.'
    Assert-Equal $receipt.innerArchive.sha256 ([string]$pin.package.innerSha256) 'Receipt inner ZIP hash differs.'
    Assert-Equal $receipt.packageInventory.Count 19 'Receipt file inventory count differs.'
    Assert-Equal $receipt.packageInventorySha256 ([string]$pin.package.canonicalInventorySha256) 'Receipt inventory digest differs.'
    Assert-Equal $receipt.executable.peMachine 'AMD64' 'Receipt PE machine differs.'
    Assert-Equal $receipt.executable.peFormat 'PE32+' 'Receipt PE format differs.'
    Assert-Equal $receipt.executable.resourceDirectoryPresent $true 'Receipt PE resource directory is absent.'
    Assert-Equal $receipt.launchers.executed $false 'A launcher was executed.'
    Assert-Equal $receipt.noLaunch.appLaunched $false 'The app was launched.'
    Assert-Equal $receipt.noLaunch.launcherExecuted $false 'A launcher was executed.'
    Assert-Equal $receipt.noLaunch.driverServiceStarted $false 'A driver service was started.'
    Assert-Equal $receipt.noLaunch.guiTested $false 'GUI testing occurred.'
    Assert-True ([string]$receipt.innerArchive.name -ceq [string]$pin.package.innerName) 'Mutating the caller candidate changed the verified receipt.'
    $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 12 -Compress
    Assert-True (-not $receiptJson.Contains($successTransport.Token, [StringComparison]::Ordinal)) 'Verified receipt leaked the synthetic bearer token.'
    Assert-True (-not $receiptJson.Contains($successTransport.Sas, [StringComparison]::Ordinal)) 'Verified receipt leaked the synthetic SAS query.'
    Assert-Equal ($receipt.Keys -join ',') 'schema,status,repository,candidateBuildRunId,candidateBuildRunAttempt,sourceBranch,sourceSha,sourceTree,artifact,outerArchive,innerArchive,packageInventory,packageInventorySha256,buildInfo,sha256Sums,launchers,mcpResourceSha256,demoVault,executable,noLaunch' 'Verified receipt projection contains unexpected or missing fields.'
    Assert-True ([IO.File]::Exists($script:SuccessfulResult.receiptPath)) 'Verified receipt file was not written.'
    Assert-Equal (Get-FileSha256 $script:SuccessfulResult.artifactPath) ([string]$pin.package.outerSha256) 'Staged artifact hash differs.'
    Assert-Equal (Get-FileSha256 $script:SuccessfulResult.innerZipPath) ([string]$pin.package.innerSha256) 'Staged inner ZIP hash differs.'
    Assert-True (-not [IO.File]::Exists((Join-Path $successStage 'downloads/artifact.zip.part'))) 'Private part file survived successful publication.'
  }

  Invoke-Case 'wrong-metadata-refused-before-download' {
    $stage = Join-Path $evidencePath 'bad-metadata-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'metadataMismatch'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null } 'differs'
    Assert-Equal $flow.Calls.Count 1 'Metadata mismatch unexpectedly continued to another GET.'
    Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Metadata mismatch published artifact bytes.'
  }

  Invoke-Case 'metadata-shape-size-expiry-and-body-limits' {
    foreach ($scenario in @('metadataWrongSize', 'metadataExpired', 'metadataExpiredStringFalse', 'metadataMalformed', 'metadataOversize', 'metadataWrongContentLength')) {
      $stage = Join-Path $evidencePath ('metadata-' + $scenario + '-stage')
      $flow = New-TransportFixture $script:TestCandidate $artifactBytes $scenario
      Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null }
      Assert-Equal $flow.Calls.Count 1 'Rejected metadata unexpectedly issued another GET.'
      Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Rejected metadata published artifact bytes.'
    }
  }

  Invoke-Case 'redirect-host-refused-before-blob-get' {
    $stage = Join-Path $evidencePath 'bad-redirect-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'redirectWrongHost'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null }
    Assert-Equal $flow.Calls.Count 2 'Rejected redirect continued to blob GET.'
    Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Rejected redirect published artifact bytes.'
  }

  Invoke-Case 'redirect-without-location-refused-before-blob-get' {
    $stage = Join-Path $evidencePath 'missing-location-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'redirectMissingLocation'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null }
    Assert-Equal $flow.Calls.Count 2 'Missing redirect location continued to blob GET.'
    Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Missing redirect location published artifact bytes.'
  }

  Invoke-Case 'wrong-blob-hash-deletes-part-and-publishes-nothing' {
    $stage = Join-Path $evidencePath 'bad-blob-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'blobWrongHash'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null } 'failed safely'
    Assert-Equal $flow.Calls.Count 3 'Blob integrity failure did not reach exactly the blob request.'
    Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Bad blob bytes were published.'
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $stage 'downloads') -Filter '*.part' -Force).Count 0 'Bad blob temporary file was retained.'
  }

  Invoke-Case 'blob-content-length-mismatch-deletes-part' {
    $stage = Join-Path $evidencePath 'bad-blob-length-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'blobWrongContentLength'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null } 'failed safely'
    Assert-Equal $flow.Calls.Count 3 'Blob length failure did not occur on the third GET.'
    Assert-True (-not [IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Bad Content-Length response was published.'
    Assert-Equal @(Get-ChildItem -LiteralPath (Join-Path $stage 'downloads') -Filter '*.part' -Force).Count 0 'Bad Content-Length temporary file was retained.'
  }

  Invoke-Case 'transport-secrets-are-redacted' {
    $stage = Join-Path $evidencePath 'secret-error-stage'
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'throwSecret'
    $secretMessage = $null
    try { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $script:TestCandidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null }
    catch { $secretMessage = [string]$_.Exception.Message }
    Assert-True ($null -ne $secretMessage) 'Injected transport error was not returned.'
    Assert-True (-not $secretMessage.Contains($flow.Token, [StringComparison]::Ordinal)) 'Error leaked the test bearer token.'
    Assert-True (-not $secretMessage.Contains($flow.Sas, [StringComparison]::Ordinal)) 'Error leaked the test SAS query.'
    Assert-Equal $secretMessage 'The hermetic artifact transport failed safely.' 'Transport error did not use the fixed secret-free failure message.'
  }

  Invoke-Case 'expired-overall-deadline-sends-no-request' {
    $flow = New-TransportFixture $script:TestCandidate $artifactBytes 'success'
    $expiredDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds(-1)
    Assert-Throws {
      Get-PinnedArtifactMetadata -Token $flow.Token -Candidate $script:TestCandidate -Transport $flow.Callback -DeadlineUtc $expiredDeadline | Out-Null
    } 'exceeded its overall deadline'
    Assert-Equal $flow.Calls.Count 0 'An expired overall deadline sent a request.'
  }

  Invoke-Case 'expired-candidate-is-rejected-before-stage-or-request' {
    $candidate = New-TestCandidate
    $candidate.artifact.expiresAtUtc = '2000-01-01T00:00:00.000Z'
    $flow = New-TransportFixture $candidate $artifactBytes 'success' $script:TestInventory
    $stage = Join-Path $evidencePath 'expired-candidate-stage'
    Assert-Throws { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $candidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null } 'expired or has an invalid pinned expiry'
    Assert-Equal $flow.Calls.Count 0 'An expired candidate sent a request.'
    Assert-True (-not [IO.Directory]::Exists($stage)) 'An expired candidate created its stage directory.'
    $expiry = [DateTimeOffset]::Parse([string]$script:TestCandidate.artifact.expiresAtUtc, [Globalization.CultureInfo]::InvariantCulture)
    Assert-Throws { Assert-FirstLaunchCandidateNotExpired -Candidate $script:TestCandidate -NowUtc $expiry | Out-Null } 'expired or has an invalid pinned expiry'
  }

  Invoke-Case 'package-tree-rejects-unexpected-directory-and-reparse-before-descent' {
    $positiveRoot = Join-Path $evidencePath 'tree-positive'
    [void][IO.Directory]::CreateDirectory((Join-Path $positiveRoot 'nested'))
    [IO.File]::WriteAllText((Join-Path $positiveRoot 'one.txt'), 'one')
    [IO.File]::WriteAllText((Join-Path (Join-Path $positiveRoot 'nested') 'two.txt'), 'two')
    $tree = Get-FirstLaunchPackageTree -PackageRoot $positiveRoot -ExpectedFiles @('one.txt', 'nested/two.txt')
    Assert-Equal $tree.FileCount 2 'Expected package tree file count differs.'
    Assert-Equal $tree.DirectoryCount 1 'Expected package tree directory count differs.'

    $extraRoot = Join-Path $evidencePath 'tree-unexpected-directory'
    [void][IO.Directory]::CreateDirectory((Join-Path $extraRoot 'unexpected'))
    [IO.File]::WriteAllText((Join-Path $extraRoot 'expected.txt'), 'expected')
    [IO.File]::WriteAllText((Join-Path (Join-Path $extraRoot 'unexpected') 'hidden.txt'), 'hidden')
    Assert-Throws { Get-FirstLaunchPackageTree -PackageRoot $extraRoot -ExpectedFiles @('expected.txt') | Out-Null }

    $targetRoot = Join-Path $evidencePath 'tree-link-target'
    $linkRoot = Join-Path $evidencePath 'tree-reparse-root'
    [void][IO.Directory]::CreateDirectory($targetRoot)
    [void][IO.Directory]::CreateDirectory($linkRoot)
    [IO.File]::WriteAllText((Join-Path $targetRoot 'must-not-descend.txt'), 'marker')
    [IO.File]::WriteAllText((Join-Path $linkRoot 'expected.txt'), 'expected')
    $linkPath = Join-Path $linkRoot 'linked-directory'
    $linkCreated = $false
    try { [void][IO.Directory]::CreateSymbolicLink($linkPath, $targetRoot); $linkCreated = $true }
    catch { $script:SkippedCases.Add('directory-reparse-symlink-creation-unavailable') }
    if ($linkCreated) {
      Assert-Throws { Get-FirstLaunchPackageTree -PackageRoot $linkRoot -ExpectedFiles @('expected.txt', 'linked-directory/must-not-descend.txt') | Out-Null } 'reparse'
      Assert-Throws { Assert-FirstLaunchNewDirectoryPath -Path (Join-Path $linkPath 'new-stage') -Label 'Synthetic stage' | Out-Null } 'reparse'
      Assert-True ([IO.File]::Exists((Join-Path $targetRoot 'must-not-descend.txt'))) 'Reparse validation altered or descended into its external target.'
    }
  }

  Invoke-Case 'create-new-write-preserves-preexisting-file' {
    $existing = Join-Path $evidencePath 'preexisting-protected-file.bin'
    $original = [Text.UTF8Encoding]::new($false).GetBytes('preserve-me')
    [IO.File]::WriteAllBytes($existing, $original)
    $replacement = [Text.UTF8Encoding]::new($false).GetBytes('must-not-overwrite')
    Assert-Throws { Write-FirstLaunchNewFile -Path $existing -Bytes $replacement } 'could not be written safely'
    Assert-Equal ([Text.UTF8Encoding]::new($false).GetString([IO.File]::ReadAllBytes($existing))) 'preserve-me' 'Rejected create-new changed the existing file.'
  }

  Invoke-Case 'zip-path-policy-adversarial-names' {
    $names = @(
      '../escape.txt',
      '/absolute.txt',
      'C:/drive.txt',
      'safe/stream:payload',
      'CON.txt',
      'trailing./item.txt',
      'trailing /item.txt',
      'PROGRA~1/item.txt',
      'ALPHA~12/item.txt',
      'folder/has?.txt',
      ('control' + [char]0x0001 + '.txt'),
      ('Cafe' + [char]0x0301 + '.txt')
    )
    $index = 0
    foreach ($name in $names) {
      $index++
      $zipPath = Join-Path $evidencePath ('path-' + $index + '.zip')
      New-SyntheticZip $zipPath @($name)
      if ($name.Contains([char]0x0301)) {
        $nfdRejected = $false
        try { Assert-FirstLaunchZipPolicy -ArchivePath $zipPath -ExpectedTotalBytes -1 | Out-Null }
        catch { $nfdRejected = ([string]$_.Exception.Message).Contains('non-canonical Unicode normalization', [StringComparison]::OrdinalIgnoreCase) }
        if (-not $nfdRejected) { throw 'The ZIP policy accepted a decomposed Unicode path instead of rejecting its non-canonical normalization.' }
      } else {
        Assert-Throws { Assert-FirstLaunchZipPolicy -ArchivePath $zipPath -ExpectedTotalBytes -1 | Out-Null }
      }
    }
    foreach ($name in @('PROGRA~1/item.txt', 'ALPHA~12/item.txt', 'folder/has?.txt', ('control' + [char]0x0001 + '.txt'), ('Cafe' + [char]0x0301 + '.txt'))) {
      Assert-Throws { Get-FirstLaunchZipPathPolicy $name $false | Out-Null }
    }
    Assert-Equal (Get-FirstLaunchZipPathPolicy 'Program Files/item.txt' $false) 'Program Files/item.txt' 'Canonical safe path was refused.'
  }

  Invoke-Case 'zip-duplicate-collision-and-corruption' {
    $duplicateCases = @(
      [pscustomobject]@{ Name = 'same-entry'; Names = [string[]]@('same.txt', 'same.txt') },
      [pscustomobject]@{ Name = 'case-alias'; Names = [string[]]@('node.txt', 'NODE.txt') },
      [pscustomobject]@{ Name = 'file-parent'; Names = [string[]]@('parent', 'parent/child.txt') }
    )
    foreach ($duplicateCase in $duplicateCases) {
      $zipPath = Join-Path $evidencePath ('duplicate-' + $duplicateCase.Name + '.zip')
      New-SyntheticZip $zipPath $duplicateCase.Names
      Assert-Throws { Assert-FirstLaunchZipPolicy -ArchivePath $zipPath -ExpectedTotalBytes -1 | Out-Null }
    }
    $crcZip = Join-Path $evidencePath 'crc-corrupt.zip'
    New-SyntheticZip $crcZip @('payload.bin')
    $bytes = [IO.File]::ReadAllBytes($crcZip)
    $localIndex = -1
    for ($i = 0; $i -le ($bytes.Length - 4); $i++) {
      if ([BitConverter]::ToUInt32($bytes, $i) -eq 0x04034b50) { $localIndex = $i; break }
    }
    Assert-True ($localIndex -ge 0) 'Synthetic ZIP local header was not found.'
    $nameLength = [BitConverter]::ToUInt16($bytes, $localIndex + 26)
    $extraLength = [BitConverter]::ToUInt16($bytes, $localIndex + 28)
    $payloadOffset = $localIndex + 30 + $nameLength + $extraLength
    $bytes[$payloadOffset] = [byte]($bytes[$payloadOffset] -bxor 1)
    [IO.File]::WriteAllBytes($crcZip, $bytes)
    Assert-Throws { Assert-FirstLaunchZipPolicy -ArchivePath $crcZip -ExpectedTotalBytes -1 | Out-Null }
    $truncated = Join-Path $evidencePath 'truncated.zip'
    [IO.File]::WriteAllBytes($truncated, [byte[]](0x50, 0x4b, 0x03, 0x04))
    Assert-Throws { Assert-FirstLaunchZipPolicy -ArchivePath $truncated -ExpectedTotalBytes -1 | Out-Null }
  }

  Invoke-Case 'nfd-inner-path-is-rejected-before-extraction' {
    $nfdName = 'Cafe' + [char]0x0301 + '.txt'
    $maliciousInner = Join-Path $evidencePath 'inner-nfd.zip'
    New-SyntheticZip $maliciousInner @($nfdName)
    $innerBytes = [IO.File]::ReadAllBytes($maliciousInner)
    $innerHash = Get-FileSha256 $maliciousInner
    $maliciousOuter = Join-Path $evidencePath 'outer-wrapped-inner-nfd.zip'
    New-SyntheticZipWithPayload $maliciousOuter ([string]$pin.package.innerName) $innerBytes
    $badBytes = [IO.File]::ReadAllBytes($maliciousOuter)
    $outerHash = Get-FileSha256 $maliciousOuter
    $candidate = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $script:TestCandidate -Depth 20 -Compress) -AsHashtable -DateKind String
    $candidate.artifact.sizeBytes = [long]$badBytes.Length
    $candidate.artifact.digest = 'sha256:' + $outerHash
    $candidate.package.outerSha256 = $outerHash
    $candidate.package.innerSizeBytes = [long]$innerBytes.Length
    $candidate.package.innerSha256 = $innerHash
    $candidate.package.innerEntryCount = 1
    $candidate.package.innerTotalBytes = [long]3
    $stage = Join-Path $evidencePath 'unsafe-path-stage'
    $flow = New-TransportFixture $candidate $badBytes 'success' $script:TestInventory
    $failureMessage = $null
    try { Get-FirstLaunchVerifiedPackage -Token $flow.Token -StageRoot $stage -Candidate $candidate -ExpectedInventory $script:TestInventory -Transport $flow.Callback | Out-Null }
    catch { $failureMessage = Get-SanitizedFailure $_ }
    if ($null -eq $failureMessage) { throw 'Synthetic inner archive unexpectedly passed full package verification.' }
    if ($flow.Calls.Count -ne 3) { throw ('Unsafe inner-path flow stopped after ' + [string]$flow.Calls.Count + ' synthetic requests: ' + $failureMessage) }
    Assert-True ([IO.File]::Exists((Join-Path $stage 'downloads/artifact.zip'))) 'Synthetic artifact was not safely staged before ZIP policy validation.'
    $stagedInnerPath = Join-Path (Join-Path $stage 'source-artifact') ([string]$pin.package.innerName)
    Assert-True ([IO.File]::Exists($stagedInnerPath)) 'The exact pinned inner archive was not extracted from the outer ZIP.'
    if (-not $failureMessage.Contains('non-canonical Unicode normalization', [StringComparison]::OrdinalIgnoreCase)) {
      if ([IO.Directory]::Exists((Join-Path $stage 'package'))) {
        throw 'The NFD inner entry passed ZIP path validation and was extracted into the package stage before later failure.'
      }
      throw 'The NFD inner ZIP did not fail at the path normalization policy.'
    }
    Assert-True (-not [IO.Directory]::Exists((Join-Path $stage 'package'))) 'The NFD inner path was extracted before path normalization was rejected.'
  }

  Invoke-Case 'receipt-is-data-only-and-package-launchers-remain-static' {
    $receipt = $script:SuccessfulResult.receipt
    Assert-Equal $receipt.noLaunch.appLaunched $false 'App launch flag is not false.'
    Assert-Equal $receipt.noLaunch.launcherExecuted $false 'Launcher execution flag is not false.'
    Assert-Equal $receipt.noLaunch.driverServiceStarted $false 'Driver service flag is not false.'
    Assert-Equal $receipt.noLaunch.guiTested $false 'GUI test flag is not false.'
    $sourceText = [IO.File]::ReadAllText($ModulePath)
    Assert-True ($sourceText -match 'launcherExecuted = \$false') 'Source no-launch statement is missing.'
    Assert-True ($sourceText -notmatch '(?im)^\s*(Start-Process|Invoke-Expression)\b') 'Preflight contains a direct process launcher.'
    Assert-True ($sourceText -notmatch '(?im)^\s*&\s*[^#].*\.exe\b') 'Preflight contains a direct executable invocation.'
  }

  if ($script:Failures.Count -eq 0) { $script:Status = 'passed' }
} catch {
  $script:Failures.Add([pscustomobject]@{ case = 'harness'; message = (Get-SanitizedFailure $_) })
} finally {
  $receipt = [ordered]@{
    schema = 'morrow.e003.g23.issue-252-independent-test-receipt.v2'
    status = $script:Status
    base = '9f60b4df4ae823b0d5381421ed7c1707eb84511c'
    productionSha256 = $script:SourceSha256
    legacyHelperSha256 = $script:LegacySha256
    outerArtifactSha256 = $script:OuterSha256
    innerPackageSha256 = $script:InnerSha256
    casesPassed = $script:Cases.Count
    caseNames = @($script:Cases)
    skippedCaseCount = $script:SkippedCases.Count
    skippedCases = @($script:SkippedCases)
    failureCount = $script:Failures.Count
    failures = @($script:Failures)
    noLaunch = [ordered]@{ appLaunched = $false; launcherExecuted = $false; driverServiceStarted = $false; guiTested = $false }
  }
  $receiptPath = Join-Path $evidencePath 'independent-receipt.json'
  if (-not [IO.File]::Exists($receiptPath)) {
    [IO.File]::WriteAllText($receiptPath, (ConvertTo-Json -InputObject $receipt -Depth 8), [Text.UTF8Encoding]::new($false))
  }
}
$receiptJson = [IO.File]::ReadAllText((Join-Path $evidencePath 'independent-receipt.json'), [Text.Encoding]::UTF8)
Write-Output $receiptJson
if ($script:Status -ne 'passed') { exit 1 }
