[CmdletBinding()]
param(
  [switch] $LibraryOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:FirstLaunchCandidate = [ordered]@{
  repository = 'hodeliun/Morrow'
  branch = 'pilot/e003-polaris-dados-2.0'
  sourceSha = 'bdf54cd4eb6f20e63664c00cf46209a5c941065e'
  sourceTree = '4778832b283814759fafc8945eacffe3fa1e1baf'
  buildRunId = '44961916968'
  buildRunAttempt = '1'
  artifact = [ordered]@{
    id = '14730062702'
    name = 'morrow-polaris-dados-windows-build-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e'
    digest = 'sha256:008b17dd30a28fcad18070f9415aa43b4ca0e1c91f5acf7e8bfe38f817af4c65'
    sizeBytes = [long]31988714
    expiresAtUtc = '2026-11-28T23:34:10.000Z'
  }
  package = [ordered]@{
    outerSha256 = '008b17dd30a28fcad18070f9415aa43b4ca0e1c91f5acf7e8bfe38f817af4c65'
    innerName = 'morrow-polaris-dados-windows-44961916968-1-bdf54cd4eb6f20e63664c00cf46209a5c941065e.zip'
    innerSizeBytes = [long]32037277
    innerSha256 = '678270f73fa90bb1f58af11b0a5de74245c002887270a809fc2c85ff1002373e'
    innerEntryCount = 21
    innerTotalBytes = [long]53867047
    fileInventoryCount = 19
    canonicalInventorySha256 = 'd8d4e6cb1a419cc342f9f63f43c5931cc1d3feb6041a4a1f7d104167104b9baf'
    buildInfoSizeBytes = [long]7175
    buildInfoSha256 = '480080192f50de4b5388adc4c1f76cb1c99fb4a50ae0725c4e32aa529c112efa'
    sha256SumsSizeBytes = [long]1919
    sha256SumsSha256 = '343bd75415c4b51c265f4d547099aa4a8fdf7ec917b81344250bde55ce204adb'
    launcherSha256 = '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79'
    launcherCmdSha256 = 'b22e8236a258f9aceccd4476c2d4e3490a9fcc63a699476d6af691a5bc6e4798'
    mcpResourceSha256 = '555b5b5aeb441f1fc10958aeea3bb49c694810d369de60833d1a3d46cb498ade'
    overlayPath = 'src-tauri/tauri.pilot.conf.json'
    overlaySha256 = 'c2e8898d991f38da8418a0cdac156f163c0e8b968a3f03c601bac67d2bbbcf9f'
    mcpResourceSource = '../dist-mcp/index.js'
    mcpResourceTarget = 'mcp/index.js'
    demoVaultPath = 'DemoVault'
    demoVaultSha256 = '7090716fb431d19f6ee0b2db463280352a34ffffbe23fded9f807d8cfaa65a1a'
    executableSizeBytes = [long]51768832
    executableSha256 = '85015c92631dbfcef49856c6729accd1c4d2567c097ef87c5ebad38745f99879'
    pilotIdentifier = 'app.morrow.polaris-dados-pilot'
    applicationVersion = '2.2.0'
    sourceAuditSha256 = '77f85cf358e799fef123ab4218e29acf30320711f8edaa12251885880002dcc8'
  }
}

$script:PinnedPackageInventory = @(
  [ordered]@{ path = 'DemoVault/.morrow/plugins.json'; sizeBytes = [long]43; sha256 = 'fccc40d7f515aafe89f665615e6872fea972c873a17fc861d1f9b2d2c3fc06b6' },
  [ordered]@{ path = 'DemoVault/.morrow/plugins/polaris-dados/LICENSE'; sizeBytes = [long]11558; sha256 = '1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6' },
  [ordered]@{ path = 'DemoVault/.morrow/plugins/polaris-dados/main.js'; sizeBytes = [long]111948; sha256 = '27c108b72897466aeb47e978c4633911d8e64c6d703f03e97d6b20c7a27cfee3' },
  [ordered]@{ path = 'DemoVault/.morrow/plugins/polaris-dados/manifest.json'; sizeBytes = [long]178; sha256 = '6708670c4529d683a8269252115f069500d465fa4369d0c4f43447c4f945e145' },
  [ordered]@{ path = 'DemoVault/.morrow/plugins/polaris-dados/README.md'; sizeBytes = [long]5957; sha256 = '4f80935c9f7b2993c002e2249a3577ae9127d858f07c0c409aa7fdb0e75c6abb' },
  [ordered]@{ path = 'DemoVault/.morrow/workspace.json'; sizeBytes = [long]913; sha256 = '48523143d05636f52585aec2a8cb528fdb8ed18319efdc9d81615eb2166f66ab' },
  [ordered]@{ path = 'DemoVault/Checklist Views.md'; sizeBytes = [long]555; sha256 = '6e7410847b51bbcddf2bddcfc8160ed730262b0f3f9a3fa40b157151e2560de6' },
  [ordered]@{ path = 'DemoVault/Checklist.md'; sizeBytes = [long]405; sha256 = 'c12c55141e6a4a5997e36254c8c3195b56da291d9b71096f6e800e6d76279848' },
  [ordered]@{ path = 'DemoVault/Checklist/Missing.md'; sizeBytes = [long]60; sha256 = 'ba3855e412d01c0edb3d7fecb99c120c129ff88d4995bdf6f8037a0c683dd810' },
  [ordered]@{ path = 'DemoVault/Checklist/Null.md'; sizeBytes = [long]68; sha256 = '58b1a30cf4072c8fe9fbf3930545e38a017174cd5b34ea8c584ee9f2362c1935' },
  [ordered]@{ path = 'DemoVault/Checklist/Unchecked.md'; sizeBytes = [long]60; sha256 = '6936d098a993c248b91a37babf47bebbfe4c956bd556f1256e04f964972a4146' },
  [ordered]@{ path = 'DemoVault/Inventory.md'; sizeBytes = [long]569; sha256 = '46911f087baee1a0eac73b2e62ba0904c2c55f641119bfb416b92bad729d1383' },
  [ordered]@{ path = 'DemoVault/Inventory/Widget.md'; sizeBytes = [long]105; sha256 = '306a70f5cde5e6dc4956a016812f54f216f716f0ff196d038f55c5c6e01be700' },
  [ordered]@{ path = 'DemoVault/Views.md'; sizeBytes = [long]828; sha256 = 'dc99d9eb869c51f4b17bc03044b587af249323c737f85f83cd8229ad0e17f2b0' },
  [ordered]@{ path = 'mcp/index.js'; sizeBytes = [long]1928614; sha256 = '555b5b5aeb441f1fc10958aeea3bb49c694810d369de60833d1a3d46cb498ade' },
  [ordered]@{ path = 'morrow.exe'; sizeBytes = [long]51768832; sha256 = '85015c92631dbfcef49856c6729accd1c4d2567c097ef87c5ebad38745f99879' },
  [ordered]@{ path = 'TESTAR-NO-WINDOWS.md'; sizeBytes = [long]6298; sha256 = '4df976b8340fd3cefaa00472302bc5599020021c31c593a3b28ad2fcf386908b' },
  [ordered]@{ path = 'windows-launch.cmd'; sizeBytes = [long]329; sha256 = 'b22e8236a258f9aceccd4476c2d4e3490a9fcc63a699476d6af691a5bc6e4798' },
  [ordered]@{ path = 'windows-launch.ps1'; sizeBytes = [long]20633; sha256 = '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79' }
)

$script:ArtifactApiRoot = 'https://api.github.com'
$script:MaxMetadataBytes = 1MB
$script:MaxRedirectResponseBytes = 16KB
$script:ArtifactRequestTimeoutMs = 30000
$script:ArtifactBlobTimeoutMs = 120000
$script:ArtifactOverallDeadlineMs = 180000
$script:AllowedBlobHostPattern = '^productionresultssa[0-9]+\.blob\.core\.windows\.net$'
$script:BuildInfoPath = 'BUILD-INFO.json'
$script:Sha256SumsPath = 'SHA256SUMS'

function Import-FirstLaunchNeutralHelpers {
  $legacyPath = Join-Path $PSScriptRoot 'windows-preflight.ps1'
  if (-not [IO.File]::Exists($legacyPath)) { throw 'The pinned legacy ZIP helper source is missing.' }
  $script:LegacyZipHelperModule = New-Module -Name MorrowFirstLaunchNeutralZipHelpers -ArgumentList $legacyPath -ScriptBlock {
    param([string] $InputPath)
    . $InputPath -LibraryOnly
    Export-ModuleMember -Function Get-Sha256, Get-ZipEntryPath, Assert-NoPathCollision, Assert-NoReparsePath, Assert-ZipArchiveSafe, Expand-SafeZipArchive
  }
  Import-Module -ModuleInfo $script:LegacyZipHelperModule -Force -ErrorAction Stop
}

Import-FirstLaunchNeutralHelpers

function Get-FirstLaunchPins {
  return (Copy-FirstLaunchValue $script:FirstLaunchCandidate)
}

function Get-FirstLaunchInventory {
  return ,(Copy-FirstLaunchValue $script:PinnedPackageInventory)
}

function Copy-FirstLaunchValue {
  param([Parameter(Mandatory = $true)][object] $Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 20 -Compress
  return (ConvertFrom-Json -InputObject $json -AsHashtable -DateKind String -ErrorAction Stop)
}

function Test-FirstLaunchSameJsonValue {
  param([object] $Left, [object] $Right)
  $leftJson = ConvertTo-Json -InputObject $Left -Depth 20 -Compress
  $rightJson = ConvertTo-Json -InputObject $Right -Depth 20 -Compress
  return [string]::Equals($leftJson, $rightJson, [StringComparison]::Ordinal)
}

function Assert-FirstLaunchCandidateNotExpired {
  param([object] $Candidate, [DateTimeOffset] $NowUtc = [DateTimeOffset]::UtcNow)
  $pinnedExpiry = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Candidate.artifact.expiresAtUtc, [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$pinnedExpiry) -or
      $pinnedExpiry.ToUniversalTime() -le $NowUtc.ToUniversalTime()) {
    throw 'The pinned GitHub artifact is expired or has an invalid pinned expiry.'
  }
  return $pinnedExpiry.ToUniversalTime()
}

function Write-FirstLaunchNewFile {
  param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][byte[]] $Bytes)
  $output = $null
  $created = $false
  try {
    $output = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    $output.Write($Bytes, 0, $Bytes.Length)
    $output.Flush($true)
  } catch {
    if ($null -ne $output) { try { $output.Dispose() } catch {}; $output = $null }
    if ($created -and [IO.File]::Exists($Path)) { try { [IO.File]::Delete($Path) } catch {} }
    throw 'A new first-launch file could not be written safely.'
  } finally {
    if ($null -ne $output) { $output.Dispose() }
  }
}

function Get-FirstLaunchRemainingTimeoutMs {
  param([DateTimeOffset] $DeadlineUtc, [int] $PerRequestMaximumMs)
  $remaining = [int][Math]::Floor(($DeadlineUtc - [DateTimeOffset]::UtcNow).TotalMilliseconds)
  if ($remaining -le 0) { throw 'The package download exceeded its overall deadline.' }
  return [Math]::Min($remaining, $PerRequestMaximumMs)
}

function Convert-FirstLaunchHeadersToMap {
  param([object] $Headers)
  $map = [ordered]@{}
  if ($null -eq $Headers) { return $map }
  if ($Headers -is [System.Collections.IDictionary]) {
    foreach ($key in $Headers.Keys) { $map[[string]$key] = [string]$Headers[$key] }
    return $map
  }
  foreach ($property in $Headers.PSObject.Properties) { $map[[string]$property.Name] = [string]$property.Value }
  return $map
}

function Get-FirstLaunchHeaderValue {
  param([System.Collections.IDictionary] $Headers, [string] $Name)
  foreach ($key in $Headers.Keys) {
    if ([string]::Equals([string]$key, $Name, [StringComparison]::OrdinalIgnoreCase)) {
      return [string]$Headers[$key]
    }
  }
  return $null
}

function Assert-FirstLaunchApiIdentity {
  param([object] $Candidate)
  $pinned = $script:FirstLaunchCandidate
  if ([string]$Candidate.repository -cne [string]$pinned.repository -or
      [string]$Candidate.artifact.id -cne [string]$pinned.artifact.id -or
      [string]$Candidate.artifact.name -cne [string]$pinned.artifact.name -or
      [string]$Candidate.buildRunId -cne [string]$pinned.buildRunId -or
      [string]$Candidate.buildRunAttempt -cne [string]$pinned.buildRunAttempt -or
      [string]$Candidate.branch -cne [string]$pinned.branch -or
      [string]$Candidate.sourceSha -cne [string]$pinned.sourceSha -or
      [string]$Candidate.sourceTree -cne [string]$pinned.sourceTree) {
    throw 'Network requests are restricted to the exact pinned repository, run, artifact, branch, and source.'
  }
}

function Invoke-FirstLaunchHttpGet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][uri] $Uri,
    [System.Collections.IDictionary] $Headers = [ordered]@{},
    [Parameter(Mandatory = $true)][int] $TimeoutMs,
    [Parameter(Mandatory = $true)][long] $MaxBytes,
    [string] $BodyPath,
    [scriptblock] $Transport
  )

  if ($TimeoutMs -le 0 -or $MaxBytes -lt 0) { throw 'The HTTP request limits are invalid.' }
  if ($Uri.Scheme -cne 'https' -or -not $Uri.IsDefaultPort -or -not [string]::IsNullOrEmpty($Uri.UserInfo) -or
      -not [string]::IsNullOrEmpty($Uri.Fragment)) {
    throw 'The HTTP request URI is outside the fixed HTTPS request policy.'
  }
  $request = [pscustomobject]@{
    uri = $Uri.AbsoluteUri
    headers = [ordered]@{}
    allowAutoRedirect = $false
    timeoutMs = $TimeoutMs
    maxBytes = $MaxBytes
    destination = $BodyPath
  }
  foreach ($key in $Headers.Keys) { $request.headers[[string]$key] = [string]$Headers[$key] }

  if ($null -ne $Transport) {
    try { $response = & $Transport $request }
    catch { throw 'The hermetic artifact transport failed safely.' }
    if ($null -eq $response) { throw 'The artifact HTTP request returned no response.' }
    $responseHeaders = Convert-FirstLaunchHeadersToMap $response.Headers
    [byte[]]$bytes = @()
    if ($null -ne $response.BodyBytes) { $bytes = [byte[]]$response.BodyBytes }
    $bodyPathCreated = $false
    $declaredLength = Get-FirstLaunchHeaderValue $responseHeaders 'Content-Length'
    if ($null -ne $declaredLength) {
      $parsedLength = 0L
      if (-not [long]::TryParse($declaredLength, [ref]$parsedLength) -or $parsedLength -lt 0 -or $parsedLength -gt $MaxBytes) {
        throw 'The artifact HTTP response declares an invalid or oversized body.'
      }
      if ($parsedLength -ne $bytes.LongLength) { throw 'The artifact HTTP response body length does not match its header.' }
    }
    if ($bytes.LongLength -gt $MaxBytes) { throw 'The artifact HTTP response exceeds its byte limit.' }
    if (-not [string]::IsNullOrEmpty($BodyPath) -and [int64]$bytes.Length -gt 0 -and [int]$response.StatusCode -eq 200) {
      Write-FirstLaunchNewFile $BodyPath $bytes
      $bodyPathCreated = $true
    }
    return [pscustomobject]@{
      statusCode = [int]$response.StatusCode
      headers = $responseHeaders
      bodyBytes = if ([string]::IsNullOrEmpty($BodyPath)) { $bytes } else { [byte[]]@() }
      bodyLength = [long]$bytes.Length
      bodyPathCreated = $bodyPathCreated
    }
  }

  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $requestMessage = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
  $cancellation = [Threading.CancellationTokenSource]::new($TimeoutMs)
  $bodyFile = $null
  $bodyFileCreated = $false
  $httpResponse = $null
  try {
    foreach ($key in $Headers.Keys) {
      if (-not $requestMessage.Headers.TryAddWithoutValidation([string]$key, [string]$Headers[$key])) {
        throw 'A fixed artifact HTTP header could not be applied.'
      }
    }
    try {
      $httpResponse = $client.SendAsync($requestMessage, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
    } catch {
      throw 'The artifact HTTP request failed within its configured deadline.'
    }
    $responseHeaders = [ordered]@{}
    foreach ($header in $httpResponse.Headers) { $responseHeaders[[string]$header.Key] = [string]::Join(',', [string[]]$header.Value) }
    $contentLength = $null
    if ($null -ne $httpResponse.Content) {
      foreach ($header in $httpResponse.Content.Headers) { $responseHeaders[[string]$header.Key] = [string]::Join(',', [string[]]$header.Value) }
      $contentLength = $httpResponse.Content.Headers.ContentLength
    }
    $statusCode = [int]$httpResponse.StatusCode
    if ($null -ne $contentLength -and [long]$contentLength -gt $MaxBytes) {
      throw 'The artifact HTTP response declares a body above its byte limit.'
    }
    $bodyLength = 0L
    $bodyBytes = [byte[]]@()
    if ($statusCode -eq 200 -and $null -ne $httpResponse.Content) {
      $inputStream = $httpResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      try {
        if ([string]::IsNullOrEmpty($BodyPath)) {
          $memory = [IO.MemoryStream]::new()
          try {
            $buffer = New-Object byte[] 65536
            while (($read = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
              $bodyLength += $read
              if ($bodyLength -gt $MaxBytes) { throw 'The artifact HTTP response exceeds its byte limit.' }
              $memory.Write($buffer, 0, $read)
            }
            $bodyBytes = $memory.ToArray()
          } finally { $memory.Dispose() }
        } else {
          $bodyFile = [IO.File]::Open($BodyPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
          $bodyFileCreated = $true
          $buffer = New-Object byte[] 65536
          while (($read = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
            $bodyLength += $read
            if ($bodyLength -gt $MaxBytes) { throw 'The artifact HTTP response exceeds its byte limit.' }
            $bodyFile.Write($buffer, 0, $read)
          }
          $bodyFile.Flush($true)
        }
      } finally {
        $inputStream.Dispose()
      }
      if ($null -ne $contentLength -and $bodyLength -ne [long]$contentLength) {
        throw 'The artifact HTTP response body length does not match its header.'
      }
    }
    return [pscustomobject]@{
      statusCode = $statusCode
      headers = $responseHeaders
      bodyBytes = $bodyBytes
      bodyLength = $bodyLength
      bodyPathCreated = $bodyFileCreated
    }
  } catch {
    if ($null -ne $bodyFile) { $bodyFile.Dispose(); $bodyFile = $null }
    if ($bodyFileCreated -and [IO.File]::Exists($BodyPath)) { [IO.File]::Delete($BodyPath) }
    throw 'The artifact HTTP request failed safely.'
  } finally {
    if ($null -ne $bodyFile) { $bodyFile.Dispose() }
    if ($null -ne $httpResponse) { $httpResponse.Dispose() }
    $cancellation.Dispose()
    $requestMessage.Dispose()
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-PinnedArtifactMetadata {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Token,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [scriptblock] $Transport,
    [DateTimeOffset] $DeadlineUtc = [DateTimeOffset]::UtcNow.AddMilliseconds($script:ArtifactOverallDeadlineMs)
  )
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'A GitHub API token is required for the pinned artifact metadata request.' }
  Assert-FirstLaunchApiIdentity $Candidate
  $uri = [uri]::new($script:ArtifactApiRoot + '/repos/' + [string]$Candidate.repository + '/actions/artifacts/' + [string]$Candidate.artifact.id)
  $headers = [ordered]@{
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    Authorization = 'Bearer ' + $Token
    'User-Agent' = 'Morrow-first-launch-preflight'
  }
  $timeout = Get-FirstLaunchRemainingTimeoutMs $DeadlineUtc $script:ArtifactRequestTimeoutMs
  $response = Invoke-FirstLaunchHttpGet $uri $headers $timeout $script:MaxMetadataBytes -Transport $Transport
  if ($response.statusCode -ne 200) { throw 'The pinned GitHub artifact metadata request did not return HTTP 200.' }
  try {
    $json = [Text.UTF8Encoding]::new($false, $true).GetString([byte[]]$response.bodyBytes)
    return ConvertFrom-Json -InputObject $json -AsHashtable -DateKind String -ErrorAction Stop
  } catch {
    throw 'The pinned GitHub artifact metadata was not valid UTF-8 JSON.'
  }
}

function Assert-PinnedArtifactMetadata {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object] $Metadata,
    [object] $Candidate = $script:FirstLaunchCandidate
  )
  $artifact = $Candidate.artifact
  $expiredValue = $null
  if ($Metadata -is [System.Collections.IDictionary]) {
    if ($Metadata.Contains('expired')) { $expiredValue = $Metadata['expired'] }
  } elseif ($null -ne $Metadata.PSObject.Properties['expired']) {
    $expiredValue = $Metadata.PSObject.Properties['expired'].Value
  }
  if ([string]$Metadata.id -cne [string]$artifact.id -or
      [string]$Metadata.name -cne [string]$artifact.name -or
      $expiredValue -isnot [bool] -or $expiredValue -ne $false -or
      [long]$Metadata.size_in_bytes -ne [long]$artifact.sizeBytes -or
      [string]$Metadata.digest -cne [string]$artifact.digest -or
      [string]$Metadata.workflow_run.id -cne [string]$Candidate.buildRunId -or
      [string]$Metadata.workflow_run.head_sha -cne [string]$Candidate.sourceSha -or
      [string]$Metadata.workflow_run.head_branch -cne [string]$Candidate.branch) {
    throw 'GitHub artifact metadata differs from the exact pinned run, branch, source, identity, size, expiry state, or digest.'
  }
  $expiresAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Metadata.expires_at, [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expiresAt)) {
    throw 'GitHub artifact metadata has no valid expiration timestamp.'
  }
  $pinnedExpiry = Assert-FirstLaunchCandidateNotExpired $Candidate
  if ($expiresAt.ToUniversalTime() -ne $pinnedExpiry -or $expiresAt.ToUniversalTime() -le [DateTimeOffset]::UtcNow) {
    throw 'GitHub artifact expiration differs from the pinned candidate or has elapsed.'
  }
  return [pscustomobject]@{
    repository = [string]$Candidate.repository
    artifactId = [string]$artifact.id
    artifactName = [string]$artifact.name
    artifactDigest = [string]$Metadata.digest
    artifactSizeBytes = [long]$Metadata.size_in_bytes
    expiresAtUtc = $pinnedExpiry.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
    buildRunId = [string]$Candidate.buildRunId
    buildRunAttempt = [string]$Candidate.buildRunAttempt
    sourceSha = [string]$Candidate.sourceSha
    sourceTree = [string]$Candidate.sourceTree
    sourceBranch = [string]$Candidate.branch
    expired = $false
  }
}

function Get-PinnedArtifactRedirect {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Token,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [scriptblock] $Transport,
    [DateTimeOffset] $DeadlineUtc = [DateTimeOffset]::UtcNow.AddMilliseconds($script:ArtifactOverallDeadlineMs)
  )
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'A GitHub API token is required for the pinned artifact redirect request.' }
  Assert-FirstLaunchApiIdentity $Candidate
  $uri = [uri]::new($script:ArtifactApiRoot + '/repos/' + [string]$Candidate.repository + '/actions/artifacts/' + [string]$Candidate.artifact.id + '/zip')
  $headers = [ordered]@{
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    Authorization = 'Bearer ' + $Token
    'User-Agent' = 'Morrow-first-launch-preflight'
  }
  $timeout = Get-FirstLaunchRemainingTimeoutMs $DeadlineUtc $script:ArtifactRequestTimeoutMs
  $response = Invoke-FirstLaunchHttpGet $uri $headers $timeout $script:MaxRedirectResponseBytes -Transport $Transport
  if ($response.statusCode -ne 302) { throw 'The pinned GitHub artifact download endpoint did not return its expected HTTP 302 redirect.' }
  $location = Get-FirstLaunchHeaderValue $response.headers 'Location'
  if ([string]::IsNullOrWhiteSpace($location)) { throw 'The pinned GitHub artifact redirect has no Location header.' }
  return (Assert-FirstLaunchBlobUri $location)
}

function Assert-FirstLaunchBlobUri {
  param([Parameter(Mandatory = $true)][string] $Location)
  $uri = $null
  if (-not [uri]::TryCreate($Location, [UriKind]::Absolute, [ref]$uri)) { throw 'The artifact redirect is not an absolute HTTPS URI.' }
  if ($uri.Scheme -cne 'https' -or -not $uri.IsDefaultPort -or
      -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or
      $uri.Host -notmatch $script:AllowedBlobHostPattern) {
    throw 'The artifact redirect destination is outside the fixed Azure blob HTTPS host policy.'
  }
  return $uri
}

function Save-PinnedArtifactBlob {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][uri] $BlobUri,
    [Parameter(Mandatory = $true)][string] $Destination,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [scriptblock] $Transport,
    [DateTimeOffset] $DeadlineUtc = [DateTimeOffset]::UtcNow.AddMilliseconds($script:ArtifactOverallDeadlineMs)
  )
  [void](Assert-FirstLaunchCandidateNotExpired $Candidate)
  $validatedUri = Assert-FirstLaunchBlobUri $BlobUri.AbsoluteUri
  $destinationParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Destination))
  [void](Assert-FirstLaunchNoReparsePath $destinationParent 'Artifact destination directory')
  if (-not [IO.Directory]::Exists($destinationParent)) { throw 'The artifact destination directory does not exist.' }
  if ([IO.File]::Exists($Destination) -or [IO.Directory]::Exists($Destination)) { throw 'The artifact destination already exists.' }
  $artifactSize = [long]$Candidate.artifact.sizeBytes
  $headers = [ordered]@{ Accept = 'application/octet-stream'; 'User-Agent' = 'Morrow-first-launch-preflight' }
  $timeout = Get-FirstLaunchRemainingTimeoutMs $DeadlineUtc $script:ArtifactBlobTimeoutMs
  $temporary = $Destination + '.' + [Guid]::NewGuid().ToString('N') + '.part'
  $temporaryOwned = $false
  try {
    $response = Invoke-FirstLaunchHttpGet $validatedUri $headers $timeout $artifactSize $temporary -Transport $Transport
    if ($response.statusCode -ne 200) { throw 'The Azure blob artifact response did not return HTTP 200.' }
    $temporaryOwned = [bool]$response.bodyPathCreated
    $contentLength = Get-FirstLaunchHeaderValue $response.headers 'Content-Length'
    if (-not [string]::IsNullOrWhiteSpace($contentLength) -and [long]$contentLength -ne $artifactSize) {
      throw 'The Azure blob artifact Content-Length differs from the pinned artifact size.'
    }
    if (-not $temporaryOwned -and [IO.File]::Exists($temporary)) {
      throw 'The artifact partial path was occupied before the downloader created it.'
    }
    if (-not [IO.File]::Exists($temporary)) {
      if ($response.bodyBytes.LongLength -gt $artifactSize) { throw 'The Azure blob body exceeds the pinned artifact size.' }
      Write-FirstLaunchNewFile $temporary ([byte[]]$response.bodyBytes)
      $temporaryOwned = $true
    }
    [void](Assert-FirstLaunchNoReparsePath $temporary 'Downloaded artifact partial file')
    $temporaryAttributes = [IO.File]::GetAttributes($temporary)
    if (($temporaryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($temporaryAttributes -band [IO.FileAttributes]::Directory) -ne 0) {
      throw 'The artifact partial path is not a plain file.'
    }
    $actualSize = (Get-Item -LiteralPath $temporary -ErrorAction Stop).Length
    if ($actualSize -ne $artifactSize -or (Get-Sha256 $temporary) -cne [string]$Candidate.package.outerSha256) {
      throw 'The downloaded artifact ZIP size or SHA-256 differs from the exact candidate pin.'
    }
    [void](Assert-FirstLaunchCandidateNotExpired $Candidate)
    if ([IO.File]::Exists($Destination)) { throw 'The artifact destination already exists.' }
    [IO.File]::Move($temporary, $Destination)
    $temporaryOwned = $false
    return [pscustomobject]@{
      path = $Destination
      sizeBytes = $actualSize
      sha256 = [string]$Candidate.package.outerSha256
      redirectHost = $validatedUri.Host
      authorizationForwarded = $false
    }
  } catch {
    if ($temporaryOwned -and [IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch {} }
    throw 'The pinned artifact download failed safely.'
  }
}

function Get-FirstLaunchZipPathPolicy {
  param([string] $Name, [bool] $IsDirectory)
  $relative = Get-ZipEntryPath $Name $IsDirectory
  if (-not [string]::Equals($relative.Normalize([Text.NormalizationForm]::FormC), $relative, [StringComparison]::Ordinal)) {
    throw 'A ZIP path uses non-canonical Unicode normalization.'
  }
  $shortNameAlias = '^(?i:[^./]{1,6}~[0-9]+(?:\.[^./]{0,3})?)$'
  $invalidWindowsCharacters = [char[]]@('<', '>', ':', '"', '\', '|', '?', '*')
  foreach ($segment in $relative.Split('/')) {
    foreach ($character in $segment.ToCharArray()) {
      if ([char]::IsControl($character) -or $invalidWindowsCharacters -ccontains $character) {
        throw 'A ZIP path contains a Windows-invalid character or control character.'
      }
    }
    if ($segment -match $shortNameAlias) { throw 'A ZIP path uses a Windows short-name alias.' }
  }
  return $relative
}

function Assert-FirstLaunchZipPolicy {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $ArchivePath,
    [int] $ExpectedEntryCount,
    [long] $ExpectedTotalBytes
  )
  $generic = Assert-ZipArchiveSafe $ArchivePath
  if ($ExpectedEntryCount -gt 0 -and $generic.EntryCount -ne $ExpectedEntryCount) {
    throw 'A package ZIP has an unexpected number of entries.'
  }
  if ($ExpectedTotalBytes -ge 0 -and $generic.TotalUncompressedBytes -ne $ExpectedTotalBytes) {
    throw 'A package ZIP has an unexpected total uncompressed size.'
  }
  $stream = [IO.File]::OpenRead($ArchivePath)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    $caseInsensitive = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
      $relative = Get-FirstLaunchZipPathPolicy $entry.FullName $entry.FullName.EndsWith('/')
      $folded = $relative.Normalize([Text.NormalizationForm]::FormC)
      if ($caseInsensitive.ContainsKey($folded)) {
        if (-not [string]::Equals($caseInsensitive[$folded], $relative, [StringComparison]::Ordinal)) {
          throw 'ZIP entries contain case-insensitive or Unicode-normalized path duplicates.'
        }
        throw 'A ZIP archive repeats a path.'
      }
      $caseInsensitive[$folded] = $relative
    }
  } finally { $archive.Dispose() }
  return $generic
}

function Get-FirstLaunchCanonicalInventoryBytes {
  param([object[]] $Inventory)
  $canonical = @(
    foreach ($entry in $Inventory) {
      [ordered]@{
        path = [string]$entry.path
        sizeBytes = [long]$entry.sizeBytes
        sha256 = ([string]$entry.sha256).ToLowerInvariant()
      }
    }
  )
  $json = ConvertTo-Json -InputObject $canonical -Depth 5 -Compress
  return ,([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Assert-FirstLaunchBuildInfo {
  param([object] $BuildInfo, [object] $Candidate)
  $appGuiState = $null
  if ($BuildInfo.Contains('appGUIWindowsTested')) { $appGuiState = $BuildInfo['appGUIWindowsTested'] }
  if ([int]$BuildInfo.schemaVersion -ne 1 -or
      [string]$BuildInfo.applicationVersion -cne [string]$Candidate.package.applicationVersion -or
      [string]$BuildInfo.sourceBuildPlatform -cne 'windows-native' -or
      [string]$BuildInfo.run.id -cne [string]$Candidate.buildRunId -or
      [string]$BuildInfo.run.attempt -cne [string]$Candidate.buildRunAttempt -or
      [string]$BuildInfo.run.sha -cne [string]$Candidate.sourceSha -or
      [string]$BuildInfo.git.head -cne [string]$Candidate.sourceSha -or
      [string]$BuildInfo.git.branch -cne [string]$Candidate.branch -or
      [string]$BuildInfo.git.tree -cne [string]$Candidate.sourceTree -or
      [string]$BuildInfo.git.status -cne 'clean' -or
      [string]$BuildInfo.runner.os -cne 'Windows' -or
      [string]$BuildInfo.runner.architecture -cne 'X64' -or
      [string]$BuildInfo.pilotIdentifier -cne [string]$Candidate.package.pilotIdentifier -or
      $BuildInfo.appLaunched -ne $false -or $BuildInfo.windowsRuntimeTested -ne $false -or
      ($null -ne $appGuiState -and $appGuiState -ne $false)) {
    throw 'BUILD-INFO does not identify the pinned Windows 2.2 candidate and its no-launch status.'
  }
  if ([string]$BuildInfo.overlay.path -cne [string]$Candidate.package.overlayPath -or
      [string]$BuildInfo.overlay.sha256 -cne [string]$Candidate.package.overlaySha256 -or
      [string]$BuildInfo.overlay.identifier -cne [string]$Candidate.package.pilotIdentifier -or
      $BuildInfo.overlay.bundleActive -ne $false -or
      [string]$BuildInfo.overlay.mcpResourceSource -cne [string]$Candidate.package.mcpResourceSource -or
      [string]$BuildInfo.overlay.mcpResourceTarget -cne [string]$Candidate.package.mcpResourceTarget -or
      [string]$BuildInfo.template.path -cne [string]$Candidate.package.demoVaultPath -or
      [string]$BuildInfo.template.sha256 -cne [string]$Candidate.package.demoVaultSha256) {
    throw 'BUILD-INFO does not match the pinned pilot overlay, MCP resource, or synthetic demo vault.'
  }
  $requiredCommands = @('npm-ci', 'npm-check', 'cargo-fmt', 'cargo-clippy', 'cargo-test', 'tauri-windows-debug-build', 'polaris-dados-plugin-build')
  foreach ($label in $requiredCommands) {
    $command = @($BuildInfo.buildCommands | Where-Object { [string]$_.label -ceq $label })
    if ($command.Count -ne 1 -or $command[0].status -cne 'passed' -or [int]$command[0].exitCode -ne 0) {
      throw 'BUILD-INFO does not record every pinned build and test command as passed.'
    }
  }
  $tauriCommand = @($BuildInfo.buildCommands | Where-Object { [string]$_.label -ceq 'tauri-windows-debug-build' })[0]
  if ([string]$tauriCommand.command -notmatch '--debug' -or
      [string]$tauriCommand.command -notmatch '--no-bundle' -or
      [string]$tauriCommand.command -notmatch 'tauri\.pilot\.conf\.json') {
    throw 'BUILD-INFO does not prove the pinned no-bundle pilot build command.'
  }
}

function Assert-FirstLaunchPeX64 {
  param([string] $ExecutablePath)
  $stream = [IO.File]::OpenRead($ExecutablePath)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 512 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'The pinned morrow.exe is not a DOS/PE executable.' }
    [void]$stream.Seek(0x3C, [IO.SeekOrigin]::Begin)
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or $peOffset -gt ($stream.Length - 256)) { throw 'The pinned PE header offset is invalid.' }
    [void]$stream.Seek($peOffset, [IO.SeekOrigin]::Begin)
    if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -cne ('PE' + [char]0 + [char]0)) {
      throw 'The pinned morrow.exe has no PE signature.'
    }
    $machine = $reader.ReadUInt16()
    $sections = $reader.ReadUInt16()
    [void]$stream.Seek($peOffset + 20, [IO.SeekOrigin]::Begin)
    $optionalSize = $reader.ReadUInt16()
    [void]$reader.ReadUInt16()
    $optionalOffset = $peOffset + 24
    if ($machine -ne 0x8664 -or $sections -lt 1 -or $optionalSize -lt 240) {
      throw 'The pinned morrow.exe is not an AMD64 PE32+ image.'
    }
    [void]$stream.Seek($optionalOffset, [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt16() -ne 0x20B) { throw 'The pinned morrow.exe does not use PE32+.' }
    [void]$stream.Seek($optionalOffset + 112 + 16, [IO.SeekOrigin]::Begin)
    $resourceRva = $reader.ReadUInt32()
    $resourceSize = $reader.ReadUInt32()
    if ($resourceRva -eq 0 -or $resourceSize -eq 0) { throw 'The pinned morrow.exe has no PE resource directory.' }
  } finally {
    $reader.Dispose()
  }
  return [pscustomobject]@{ peMachine = 'AMD64'; peFormat = 'PE32+'; resourceDirectoryPresent = $true }
}

function Assert-FirstLaunchNoReparsePath {
  param([string] $Path, [string] $Label = 'Package path')
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    return (Assert-NoReparsePath $Path $Label)
  }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  $current = $root
  $remaining = $full.Substring($root.Length)
  foreach ($segment in $remaining.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $segment)
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) { break }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label crosses a link or reparse point." }
  }
  return $full
}

function Get-FirstLaunchPackageTree {
  param([Parameter(Mandatory = $true)][string] $PackageRoot, [Parameter(Mandatory = $true)][string[]] $ExpectedFiles)
  $root = [IO.Path]::GetFullPath($PackageRoot)
  [void](Assert-FirstLaunchNoReparsePath $root 'Package root')
  if (-not [IO.Directory]::Exists($root)) { throw 'The package root is not an existing directory.' }
  $rootAttributes = [IO.File]::GetAttributes($root)
  if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0 -or
      ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The package root is not a plain directory.'
  }

  $expectedFileSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $expectedDirectorySet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($path in $ExpectedFiles) {
    $relativeFile = Get-FirstLaunchZipPathPolicy $path $false
    if (-not $expectedFileSet.Add($relativeFile)) { throw 'The expected package inventory repeats a file path.' }
    $segments = $relativeFile.Split('/')
    $prefix = ''
    for ($index = 0; $index -lt ($segments.Length - 1); $index++) {
      $prefix = if ($prefix.Length -eq 0) { $segments[$index] } else { $prefix + '/' + $segments[$index] }
      [void]$expectedDirectorySet.Add($prefix)
    }
  }
  $maxNodes = $expectedFileSet.Count + $expectedDirectorySet.Count
  if ($maxNodes -gt 1024) { throw 'The expected package tree exceeds its bounded file and directory count.' }

  $observedFileSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $observedDirectorySet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $files = [Collections.Generic.List[string]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  $visitedNodes = 0
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    [void](Assert-FirstLaunchNoReparsePath $directory 'Package directory before descent')
    $directoryAttributes = [IO.File]::GetAttributes($directory)
    if (($directoryAttributes -band [IO.FileAttributes]::Directory) -eq 0 -or
        ($directoryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'A package directory is a reparse point or is not a directory.'
    }
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $visitedNodes++
      if ($visitedNodes -gt $maxNodes) { throw 'The extracted package exceeds its bounded expected file and directory count.' }
      [void](Assert-FirstLaunchNoReparsePath $entryPath 'Package entry')
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The extracted package contains a reparse point, symbolic link, or junction.'
      }
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      $relative = [IO.Path]::GetRelativePath($root, $entryPath).Replace([IO.Path]::DirectorySeparatorChar, [char]'/')
      $relative = Get-FirstLaunchZipPathPolicy $relative $isDirectory
      if ($isDirectory) {
        if (-not $expectedDirectorySet.Contains($relative) -or -not $observedDirectorySet.Add($relative)) {
          throw 'The extracted package contains an unexpected or repeated directory path.'
        }
        $pending.Push($entryPath)
      } else {
        if (-not $expectedFileSet.Contains($relative) -or -not $observedFileSet.Add($relative)) {
          throw 'The extracted package contains an unexpected or repeated file path.'
        }
        $files.Add($entryPath)
      }
    }
  }
  if ($observedFileSet.Count -ne $expectedFileSet.Count -or
      $observedDirectorySet.Count -ne $expectedDirectorySet.Count) {
    throw 'The extracted package tree is missing an expected file or directory.'
  }
  return [pscustomobject]@{ Files = $files.ToArray(); FileCount = $observedFileSet.Count; DirectoryCount = $observedDirectorySet.Count }
}

function Assert-FirstLaunchNewDirectoryPath {
  param([string] $Path, [string] $Label)
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    return (Assert-NoPathCollision $Path $Label)
  }
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty." }
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full)) { throw "$Label already exists." }
  $parent = [IO.Path]::GetDirectoryName($full)
  $leaf = [IO.Path]::GetFileName($full)
  if (-not [IO.Directory]::Exists($parent)) { throw "$Label parent directory is missing." }
  [void](Assert-FirstLaunchNoReparsePath $parent $Label)
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($parent)) {
    if ([string]::Equals([IO.Path]::GetFileName($entry), $leaf, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label collides with an existing case-insensitive path."
    }
  }
  return $full
}

function Assert-FirstLaunchLiveStageRoot {
  param([Parameter(Mandatory = $true)][string] $StageRoot)
  if ([IO.Path]::DirectorySeparatorChar -ne '\') {
    throw 'Live artifact downloads require a Windows-local RUNNER_TEMP stage.'
  }
  $runnerTemp = [string]$env:RUNNER_TEMP
  if ([string]::IsNullOrWhiteSpace($runnerTemp)) { throw 'RUNNER_TEMP is required for a live artifact download.' }
  $runnerFull = [IO.Path]::GetFullPath($runnerTemp).TrimEnd('\')
  if ($runnerFull -notmatch '^[A-Za-z]:\\[^:]*$' -or -not [IO.Directory]::Exists($runnerFull)) {
    throw 'RUNNER_TEMP must be an existing Windows-local drive directory.'
  }
  if (-not [string]::Equals($runnerFull, $runnerTemp.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RUNNER_TEMP must use its canonical Windows-local path.'
  }
  $runnerDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($runnerFull))
  if ($runnerDrive.DriveType -ne [IO.DriveType]::Fixed) {
    throw 'RUNNER_TEMP must reside on a fixed local Windows drive.'
  }
  [void](Assert-NoReparsePath $runnerFull 'RUNNER_TEMP')

  if (-not [IO.Path]::IsPathRooted($StageRoot)) { throw 'The live package stage must use an absolute canonical path.' }
  $stageFull = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
  if (-not [string]::Equals($stageFull, $StageRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The live package stage must use its canonical Windows-local path.'
  }
  $stageParent = [IO.Path]::GetDirectoryName($stageFull).TrimEnd('\')
  if (-not [string]::Equals($stageParent, $runnerFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The live package stage must be a new direct child of RUNNER_TEMP.'
  }
  return (Assert-NoPathCollision $stageFull 'First-launch package stage')
}

function Expand-FirstLaunchSafeZipArchive {
  param([string] $ArchivePath, [string] $DestinationPath, [long] $ExpectedEntries, [long] $ExpectedTotalBytes)
  [void](Assert-FirstLaunchZipPolicy $ArchivePath $ExpectedEntries $ExpectedTotalBytes)
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    return (Expand-SafeZipArchive $ArchivePath $DestinationPath)
  }
  $destination = Assert-FirstLaunchNewDirectoryPath $DestinationPath 'ZIP extraction destination'
  $root = [IO.Directory]::CreateDirectory($destination).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
  [void](Assert-FirstLaunchNoReparsePath $root 'ZIP extraction root')
  $stream = [IO.File]::OpenRead($ArchivePath)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    foreach ($entry in $archive.Entries) {
      $relative = Get-FirstLaunchZipPathPolicy $entry.FullName $entry.FullName.EndsWith('/')
      $nativeRelative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $nativeRelative))
      $prefix = $root + [IO.Path]::DirectorySeparatorChar
      if (-not $target.StartsWith($prefix, [StringComparison]::Ordinal)) { throw 'A ZIP target escaped its new extraction root.' }
      if ($entry.FullName.EndsWith('/')) {
        [void][IO.Directory]::CreateDirectory($target)
        [void](Assert-FirstLaunchNoReparsePath $target 'ZIP extraction directory')
        continue
      }
      $parent = [IO.Path]::GetDirectoryName($target)
      [void][IO.Directory]::CreateDirectory($parent)
      [void](Assert-FirstLaunchNoReparsePath $parent 'ZIP extraction parent')
      $input = $entry.Open()
      $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $input.CopyTo($output); $output.Flush($true) }
      finally { $output.Dispose(); $input.Dispose() }
      [void](Assert-FirstLaunchNoReparsePath $target 'ZIP extracted file')
      if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw 'A ZIP extraction has an unexpected byte length.' }
    }
  } finally { $archive.Dispose() }
  return [pscustomobject]@{ EntryCount = $ExpectedEntries; TotalUncompressedBytes = $ExpectedTotalBytes }
}

function Assert-FirstLaunchPackageInventory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $PackageRoot,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [object[]] $ExpectedInventory = $script:PinnedPackageInventory,
    [string] $InnerZipPath
  )
  $expectedPaths = @('BUILD-INFO.json', 'SHA256SUMS') + @($ExpectedInventory | ForEach-Object { [string]$_.path })
  $packageTree = Get-FirstLaunchPackageTree $PackageRoot $expectedPaths
  $actualFiles = @($packageTree.Files)
  $buildInfoPath = Join-Path $PackageRoot $script:BuildInfoPath
  $sumsPath = Join-Path $PackageRoot $script:Sha256SumsPath
  foreach ($path in @($buildInfoPath, $sumsPath)) { [void](Assert-FirstLaunchNoReparsePath $path 'Package metadata file') }
  if (-not [IO.File]::Exists($buildInfoPath) -or -not [IO.File]::Exists($sumsPath)) {
    throw 'The extracted package is missing BUILD-INFO.json or SHA256SUMS.'
  }
  if ((Get-Item -LiteralPath $buildInfoPath).Length -ne [long]$Candidate.package.buildInfoSizeBytes -or
      (Get-Sha256 $buildInfoPath) -cne [string]$Candidate.package.buildInfoSha256) {
    throw 'BUILD-INFO.json size or SHA-256 differs from the exact candidate pin.'
  }
  if ((Get-Item -LiteralPath $sumsPath).Length -ne [long]$Candidate.package.sha256SumsSizeBytes -or
      (Get-Sha256 $sumsPath) -cne [string]$Candidate.package.sha256SumsSha256) {
    throw 'SHA256SUMS size or SHA-256 differs from the exact candidate pin.'
  }
  try {
    $buildInfo = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($buildInfoPath, [Text.Encoding]::UTF8) -replace '^\uFEFF', '') -AsHashtable -ErrorAction Stop
  } catch { throw 'BUILD-INFO.json is invalid JSON.' }
  Assert-FirstLaunchBuildInfo $buildInfo $Candidate
  $inventory = @($buildInfo.fileInventory)
  if ($inventory.Count -ne [int]$Candidate.package.fileInventoryCount -or $inventory.Count -ne $ExpectedInventory.Count) {
    throw 'BUILD-INFO.json does not contain the exact pinned file inventory count.'
  }
  $normalizedInventory = @(
    foreach ($entry in $inventory) {
      if ($entry.Keys.Count -ne 3 -or -not $entry.Contains('path') -or -not $entry.Contains('sizeBytes') -or -not $entry.Contains('sha256')) {
        throw 'A BUILD-INFO inventory entry has unexpected properties.'
      }
      $path = Get-FirstLaunchZipPathPolicy ([string]$entry.path) $false
      $size = 0L
      if (-not [long]::TryParse([string]$entry.sizeBytes, [ref]$size) -or $size -lt 0 -or
          [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'A BUILD-INFO inventory entry has an invalid size or SHA-256.'
      }
      [ordered]@{ path = $path; sizeBytes = $size; sha256 = [string]$entry.sha256 }
    }
  )
  $canonicalBytes = Get-FirstLaunchCanonicalInventoryBytes $normalizedInventory
  $canonicalSha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$canonicalBytes)).ToLowerInvariant()
  $pinnedBytes = Get-FirstLaunchCanonicalInventoryBytes $ExpectedInventory
  $canonicalJson = [Text.UTF8Encoding]::new($false).GetString([byte[]]$canonicalBytes)
  $pinnedJson = [Text.UTF8Encoding]::new($false).GetString([byte[]]$pinnedBytes)
  if ($canonicalSha -cne [string]$Candidate.package.canonicalInventorySha256 -or $canonicalJson -cne $pinnedJson) {
    throw 'The BUILD-INFO inventory differs from the pinned 19-file canonical invoice.'
  }

  $sumLines = [IO.File]::ReadAllLines($sumsPath, [Text.Encoding]::UTF8)
  $expectedSums = [ordered]@{ 'BUILD-INFO.json' = [string]$Candidate.package.buildInfoSha256 }
  foreach ($entry in $normalizedInventory) {
    if ($expectedSums.Contains([string]$entry.path)) { throw 'The pinned inventory repeats a path.' }
    $expectedSums[[string]$entry.path] = [string]$entry.sha256
  }
  if ($sumLines.Count -ne $expectedSums.Count) { throw 'SHA256SUMS does not contain the exact metadata and payload file set.' }
  $actualSums = [ordered]@{}
  foreach ($line in $sumLines) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw 'SHA256SUMS contains a malformed inventory entry.' }
    $path = Get-FirstLaunchZipPathPolicy $Matches[2] $false
    if ($actualSums.Contains($path)) { throw 'SHA256SUMS repeats a path.' }
    $actualSums[$path] = $Matches[1]
  }
  foreach ($path in $expectedSums.Keys) {
    if (-not $actualSums.Contains($path) -or $actualSums[$path] -cne $expectedSums[$path]) {
      throw 'SHA256SUMS differs from the pinned BUILD-INFO file inventory.'
    }
  }

  $normalizedExpectedPaths = @('BUILD-INFO.json', 'SHA256SUMS') + @($normalizedInventory | ForEach-Object { [string]$_.path })
  if ($actualFiles.Count -ne $normalizedExpectedPaths.Count) { throw 'The extracted package contains an unexpected file count.' }
  foreach ($filePath in $actualFiles) {
    [void](Assert-FirstLaunchNoReparsePath $filePath 'Package file')
    $relative = [IO.Path]::GetRelativePath($PackageRoot, $filePath).Replace('\', '/')
    if ($normalizedExpectedPaths -cnotcontains $relative) { throw 'The extracted package contains an unpinned file.' }
    $entry = @($normalizedInventory | Where-Object { [string]$_.path -ceq $relative })
    if ($relative -eq 'BUILD-INFO.json') {
      $expectedSize = [long]$Candidate.package.buildInfoSizeBytes
      $expectedHash = [string]$Candidate.package.buildInfoSha256
    } elseif ($relative -eq 'SHA256SUMS') {
      $expectedSize = [long]$Candidate.package.sha256SumsSizeBytes
      $expectedHash = [string]$Candidate.package.sha256SumsSha256
    } else {
      if ($entry.Count -ne 1) { throw 'The extracted package inventory has an ambiguous path.' }
      $expectedSize = [long]$entry[0].sizeBytes
      $expectedHash = [string]$entry[0].sha256
    }
    if ((Get-Item -LiteralPath $filePath).Length -ne $expectedSize -or (Get-Sha256 $filePath) -cne $expectedHash) {
      throw 'An extracted package file size or SHA-256 differs from the pinned inventory.'
    }
  }
  $manifestPath = Join-Path $PackageRoot 'DemoVault/.morrow/plugins/polaris-dados/manifest.json'
  [void](Assert-FirstLaunchNoReparsePath $manifestPath 'Package plugin manifest')
  $manifest = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8)) -AsHashtable -ErrorAction Stop
  if ([string]$manifest.id -cne 'polaris-dados' -or [string]$manifest.name -cne 'Polaris Dados') {
    throw 'The pinned synthetic vault plugin manifest has an unexpected id or name.'
  }
  $launcherInventory = @($normalizedInventory | Where-Object { $_.path -ceq 'windows-launch.ps1' })
  $launcherCmdInventory = @($normalizedInventory | Where-Object { $_.path -ceq 'windows-launch.cmd' })
  $mcpInventory = @($normalizedInventory | Where-Object { $_.path -ceq 'mcp/index.js' })
  $executableInventory = @($normalizedInventory | Where-Object { $_.path -ceq 'morrow.exe' })
  if ($launcherInventory.Count -ne 1 -or $launcherInventory[0].sha256 -cne [string]$Candidate.package.launcherSha256 -or
      $launcherCmdInventory.Count -ne 1 -or $launcherCmdInventory[0].sha256 -cne [string]$Candidate.package.launcherCmdSha256 -or
      $mcpInventory.Count -ne 1 -or $mcpInventory[0].sha256 -cne [string]$Candidate.package.mcpResourceSha256 -or
      $executableInventory.Count -ne 1 -or $executableInventory[0].sha256 -cne [string]$Candidate.package.executableSha256) {
    throw 'Pinned launcher, MCP, or executable hashes do not match the canonical file inventory.'
  }
  $pe = Assert-FirstLaunchPeX64 (Join-Path $PackageRoot 'morrow.exe')
  if ($Candidate.package.executableSizeBytes -ne $null -and
      (Get-Item -LiteralPath (Join-Path $PackageRoot 'morrow.exe')).Length -ne [long]$Candidate.package.executableSizeBytes) {
    throw 'The pinned Windows executable size differs from the candidate.'
  }
  if ((Get-Sha256 (Join-Path $PackageRoot 'morrow.exe')) -cne [string]$Candidate.package.executableSha256) {
    throw 'The pinned Windows executable SHA-256 differs from the candidate.'
  }
  if ($null -ne $InnerZipPath) {
    Assert-StagedLauncherMatchesZip $InnerZipPath $PackageRoot | Out-Null
  }
  return [pscustomobject]@{
    buildInfo = $buildInfo
    packageInventory = $normalizedInventory
    packageInventorySha256 = $canonicalSha
    buildInfoSizeBytes = [long]$Candidate.package.buildInfoSizeBytes
    buildInfoSha256 = [string]$Candidate.package.buildInfoSha256
    sha256SumsSizeBytes = [long]$Candidate.package.sha256SumsSizeBytes
    sha256SumsSha256 = [string]$Candidate.package.sha256SumsSha256
    launcherSha256 = [string]$Candidate.package.launcherSha256
    launcherCmdSha256 = [string]$Candidate.package.launcherCmdSha256
    mcpResourceSha256 = [string]$Candidate.package.mcpResourceSha256
    demoVaultPath = [string]$Candidate.package.demoVaultPath
    demoVaultSha256 = [string]$Candidate.package.demoVaultSha256
    executableSizeBytes = [long]$Candidate.package.executableSizeBytes
    executableSha256 = [string]$Candidate.package.executableSha256
    pe = $pe
    fileCount = $actualFiles.Count
  }
}

function Assert-FirstLaunchPackage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $PackageRoot,
    [Parameter(Mandatory = $true)][string] $InnerZipPath,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [object[]] $ExpectedInventory = $script:PinnedPackageInventory
  )
  $result = Assert-FirstLaunchPackageInventory $PackageRoot $Candidate $ExpectedInventory $InnerZipPath
  return [pscustomobject]@{
    applicationVersion = [string]$Candidate.package.applicationVersion
    packageInventory = $result.packageInventory
    packageInventorySha256 = $result.packageInventorySha256
    buildInfoSizeBytes = $result.buildInfoSizeBytes
    buildInfoSha256 = $result.buildInfoSha256
    sha256SumsSizeBytes = $result.sha256SumsSizeBytes
    sha256SumsSha256 = $result.sha256SumsSha256
    launcherSha256 = $result.launcherSha256
    launcherCmdSha256 = $result.launcherCmdSha256
    mcpResourceSha256 = $result.mcpResourceSha256
    demoVaultPath = $result.demoVaultPath
    demoVaultSha256 = $result.demoVaultSha256
    executableSizeBytes = $result.executableSizeBytes
    executableSha256 = $result.executableSha256
    pe = $result.pe
    fileCount = $result.fileCount
    appLaunched = $false
    launcherExecuted = $false
    driverServiceStarted = $false
    guiTested = $false
  }
}

function Get-FirstLaunchVerifiedPackage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Token,
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [object] $Candidate = $script:FirstLaunchCandidate,
    [object[]] $ExpectedInventory = $script:PinnedPackageInventory,
    # Supplying Transport selects the hermetic fixture path; production callers omit it.
    [scriptblock] $Transport
  )
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'A GitHub API token is required for the pinned package download.' }
  if ($null -eq $Transport) {
    $pinnedCandidate = Copy-FirstLaunchValue $script:FirstLaunchCandidate
    $pinnedInventory = Copy-FirstLaunchValue $script:PinnedPackageInventory
    if (-not (Test-FirstLaunchSameJsonValue $Candidate $pinnedCandidate) -or
        -not (Test-FirstLaunchSameJsonValue $ExpectedInventory $pinnedInventory)) {
      throw 'Live downloads are restricted to the compiled 2.2 candidate and its canonical inventory.'
    }
    $Candidate = $pinnedCandidate
    $ExpectedInventory = $pinnedInventory
    $stageRoot = Assert-FirstLaunchLiveStageRoot $StageRoot
  } else {
    $pinnedCandidate = Copy-FirstLaunchValue $script:FirstLaunchCandidate
    $pinnedInventory = Copy-FirstLaunchValue $script:PinnedPackageInventory
    if ((Test-FirstLaunchSameJsonValue $Candidate $pinnedCandidate) -and
        (Test-FirstLaunchSameJsonValue $ExpectedInventory $pinnedInventory)) {
      throw 'The hermetic transport seam requires an explicit synthetic candidate and fixture inventory.'
    }
    $Candidate = Copy-FirstLaunchValue $Candidate
    $ExpectedInventory = Copy-FirstLaunchValue $ExpectedInventory
    $stageRoot = Assert-FirstLaunchNewDirectoryPath $StageRoot 'Hermetic package test stage'
  }
  [void](Assert-FirstLaunchCandidateNotExpired $Candidate)
  $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($script:ArtifactOverallDeadlineMs)
  [void][IO.Directory]::CreateDirectory($stageRoot)
  [void](Assert-FirstLaunchNoReparsePath $stageRoot 'First-launch package stage')
  $downloads = Join-Path $stageRoot 'downloads'
  $artifactPath = Join-Path $downloads 'artifact.zip'
  $outerRoot = Join-Path $stageRoot 'source-artifact'
  $innerZipPath = Join-Path $outerRoot ([string]$Candidate.package.innerName)
  $packageRoot = Join-Path $stageRoot 'package'

  $metadata = Get-PinnedArtifactMetadata $Token $Candidate $Transport $deadline
  $verifiedMetadata = Assert-PinnedArtifactMetadata $metadata $Candidate
  [void][IO.Directory]::CreateDirectory($downloads)
  [void](Assert-FirstLaunchNoReparsePath $downloads 'Artifact download directory')
  $redirect = Get-PinnedArtifactRedirect $Token $Candidate $Transport $deadline
  $download = Save-PinnedArtifactBlob $redirect $artifactPath $Candidate $Transport $deadline
  $outer = Assert-FirstLaunchZipPolicy $artifactPath 1 ([long]$Candidate.package.innerSizeBytes)
  if ($outer.Entries.Count -ne 1 -or [string]$outer.Entries[0].path -cne [string]$Candidate.package.innerName -or
      $outer.Entries[0].isDirectory -ne $false) {
    throw 'The outer GitHub artifact ZIP must contain only the exact pinned inner package name.'
  }
  [void](Expand-FirstLaunchSafeZipArchive $artifactPath $outerRoot 1 ([long]$Candidate.package.innerSizeBytes))
  if (-not [IO.File]::Exists($innerZipPath) -or
      (Get-Item -LiteralPath $innerZipPath).Length -ne [long]$Candidate.package.innerSizeBytes -or
      (Get-Sha256 $innerZipPath) -cne [string]$Candidate.package.innerSha256) {
    throw 'The inner package ZIP size or SHA-256 differs from the exact candidate pin.'
  }
  $inner = Assert-FirstLaunchZipPolicy $innerZipPath ([int]$Candidate.package.innerEntryCount) ([long]$Candidate.package.innerTotalBytes)
  [void](Expand-FirstLaunchSafeZipArchive $innerZipPath $packageRoot ([long]$Candidate.package.innerEntryCount) ([long]$Candidate.package.innerTotalBytes))
  $package = Assert-FirstLaunchPackage $packageRoot $innerZipPath $Candidate $ExpectedInventory
  [void](Assert-FirstLaunchCandidateNotExpired $Candidate)
  $receipt = [ordered]@{
    schema = 'morrow.e003.g23.verified-package.v1'
    status = 'verified'
    repository = [string]$Candidate.repository
    candidateBuildRunId = [string]$Candidate.buildRunId
    candidateBuildRunAttempt = [string]$Candidate.buildRunAttempt
    sourceBranch = [string]$Candidate.branch
    sourceSha = [string]$Candidate.sourceSha
    sourceTree = [string]$Candidate.sourceTree
    artifact = [ordered]@{
      id = [string]$verifiedMetadata.artifactId
      name = [string]$verifiedMetadata.artifactName
      digest = [string]$verifiedMetadata.artifactDigest
      sizeBytes = [long]$verifiedMetadata.artifactSizeBytes
      expiresAtUtc = [string]$verifiedMetadata.expiresAtUtc
      expired = $false
    }
    outerArchive = [ordered]@{
      name = 'artifact.zip'
      sizeBytes = [long]$download.sizeBytes
      sha256 = [string]$download.sha256
      entryCount = [int]$outer.EntryCount
    }
    innerArchive = [ordered]@{
      name = [string]$Candidate.package.innerName
      sizeBytes = [long]$Candidate.package.innerSizeBytes
      sha256 = [string]$Candidate.package.innerSha256
      entryCount = [int]$inner.EntryCount
      totalUncompressedBytes = [long]$inner.TotalUncompressedBytes
    }
    packageInventory = $package.packageInventory
    packageInventorySha256 = [string]$package.packageInventorySha256
    buildInfo = [ordered]@{ sizeBytes = $package.buildInfoSizeBytes; sha256 = $package.buildInfoSha256 }
    sha256Sums = [ordered]@{ sizeBytes = $package.sha256SumsSizeBytes; sha256 = $package.sha256SumsSha256 }
    launchers = [ordered]@{
      powershellSha256 = $package.launcherSha256
      cmdSha256 = $package.launcherCmdSha256
      executed = $false
    }
    mcpResourceSha256 = $package.mcpResourceSha256
    demoVault = [ordered]@{ path = $package.demoVaultPath; sha256 = $package.demoVaultSha256 }
    executable = [ordered]@{
      sizeBytes = $package.executableSizeBytes
      sha256 = $package.executableSha256
      peMachine = $package.pe.peMachine
      peFormat = $package.pe.peFormat
      resourceDirectoryPresent = $package.pe.resourceDirectoryPresent
    }
    noLaunch = [ordered]@{ appLaunched = $false; launcherExecuted = $false; driverServiceStarted = $false; guiTested = $false }
  }
  $receiptPath = Join-Path $stageRoot 'verified-package.json'
  $receiptJson = ConvertTo-Json -InputObject $receipt -Depth 12
  $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes($receiptJson)
  [void](Assert-FirstLaunchNoReparsePath $stageRoot 'Verified package receipt directory')
  Write-FirstLaunchNewFile $receiptPath $receiptBytes
  return [pscustomobject]@{
    receipt = $receipt
    receiptPath = $receiptPath
    packageRoot = $packageRoot
    artifactPath = $artifactPath
    innerZipPath = $innerZipPath
  }
}

function Assert-StagedLauncherMatchesZip {
  param([string] $InnerZipPath, [string] $PackageRoot)
  $launcherPath = Join-Path $PackageRoot 'windows-launch.ps1'
  [void](Assert-FirstLaunchNoReparsePath $PackageRoot 'Extracted package root')
  [void](Assert-FirstLaunchNoReparsePath $launcherPath 'Extracted package launcher')
  if (-not [IO.File]::Exists($launcherPath)) { throw 'The extracted package launcher is missing.' }
  $stream = [IO.File]::OpenRead($InnerZipPath)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    $entries = @($archive.Entries | Where-Object { $_.FullName -ceq 'windows-launch.ps1' })
    if ($entries.Count -ne 1) { throw 'The inner ZIP must contain exactly one pinned PowerShell launcher.' }
    $entryStream = $entries[0].Open()
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $entryHash = ([BitConverter]::ToString($sha.ComputeHash($entryStream))).Replace('-', '').ToLowerInvariant() }
      finally { $sha.Dispose() }
    } finally { $entryStream.Dispose() }
  } finally { $archive.Dispose() }
  if ((Get-Sha256 $launcherPath) -cne $entryHash) { throw 'The extracted launcher differs from the verified inner ZIP entry.' }
  return [pscustomobject]@{ sha256 = $entryHash; executed = $false }
}

if (-not $LibraryOnly) {
  throw 'This file is a package preflight library; import it with -LibraryOnly from the authorized orchestrator.'
}
