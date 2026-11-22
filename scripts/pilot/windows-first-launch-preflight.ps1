[CmdletBinding()]
param(
  [switch] $LibraryOnly,
  [switch] $ProcessShim,
  [string] $ProcessRequestPath,
  [string] $ProcessRequestSha256,
  [string] $ProcessShimScriptSha256
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
$script:FirstLaunchStageSchema = 'morrow.e003.g15.first-launch-stage.v1'
$script:FirstLaunchPurpose = 'first-windows-launch'
$script:FirstLaunchExecutionPhase = 'protected-check-only'
$script:FirstLaunchGateRepository = 'hodeliun/Morrow'
$script:FirstLaunchGateRef = 'refs/heads/codex/e003-g07-windows-runtime'
$script:FirstLaunchWorkflowPath = '.github/workflows/pilot-windows-first-launch-preflight.yml'
$script:FirstLaunchWorkflowRef = 'hodeliun/Morrow/.github/workflows/pilot-windows-first-launch-preflight.yml@refs/heads/codex/e003-g07-windows-runtime'
$script:FirstLaunchGateEvent = 'push'
$script:FirstLaunchTauriDriverVersion = '2.1.0'
$script:FirstLaunchTauriSourceUrl = 'https://crates.io/crates/tauri-driver/2.1.0'
$script:FirstLaunchTauriDownloadUrl = 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download'
$script:FirstLaunchEdgeSourcePageUrl = 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver'
$script:FirstLaunchEdgeCatalogUrl = 'https://msedgedriver.microsoft.com/listing.json'
$script:FirstLaunchEdgeRootUrl = 'https://msedgedriver.microsoft.com'
$script:FirstLaunchWebView2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$script:FirstLaunchMaxEdgeCatalogBytes = 8MB
$script:FirstLaunchMaxEdgeCatalogItems = 100000
$script:FirstLaunchMaxEdgeArchiveBytes = 64MB
$script:FirstLaunchEdgeProbeTimeoutMs = 15000
$script:FirstLaunchEdgeProbeOutputBytes = 8192
$script:FirstLaunchCargoTimeoutMs = 900000
$script:FirstLaunchCargoOutputBytes = 1MB
$script:FirstLaunchStageOwnerMarkerName = '.morrow-e003-g23-stage-owner'
$script:FirstLaunchNativeJobHelperSha256 = '39f44b25926e118e36fc9e4367705e894cfe5903a83ffc07c04acba32889d06c'
$script:FirstLaunchNativeJobModule = $null

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
  param(
    [Parameter(Mandatory = $true)][string] $ExecutablePath,
    [string] $Label = 'PE executable',
    [switch] $RequireResourceDirectory
  )
  $stream = [IO.File]::OpenRead($ExecutablePath)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { throw "$Label is not a DOS/PE executable." }
    [void]$stream.Seek(0x3C, [IO.SeekOrigin]::Begin)
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or $peOffset -gt ($stream.Length - 24)) { throw "$Label has an invalid PE header offset." }
    [void]$stream.Seek($peOffset, [IO.SeekOrigin]::Begin)
    if ([Text.Encoding]::ASCII.GetString($reader.ReadBytes(4)) -cne ('PE' + [char]0 + [char]0)) {
      throw "$Label has no PE signature."
    }
    $machine = $reader.ReadUInt16()
    $sections = $reader.ReadUInt16()
    [void]$stream.Seek($peOffset + 20, [IO.SeekOrigin]::Begin)
    $optionalSize = $reader.ReadUInt16()
    [void]$reader.ReadUInt16()
    $optionalOffset = $peOffset + 24
    if ($machine -ne 0x8664 -or $sections -lt 1 -or $optionalSize -lt 240 -or
        ($optionalOffset + $optionalSize) -gt $stream.Length -or
        ([long]$optionalOffset + $optionalSize + ([long]$sections * 40)) -gt $stream.Length) {
      throw "$Label is not a complete AMD64 PE32+ image."
    }
    [void]$stream.Seek($optionalOffset, [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt16() -ne 0x20B) { throw "$Label does not use PE32+." }
    $hasResourceDirectory = $false
    if ($RequireResourceDirectory) {
      if ($optionalSize -lt 136) { throw "$Label has no complete PE resource data-directory entry." }
      [void]$stream.Seek($optionalOffset + 112 + 16, [IO.SeekOrigin]::Begin)
      $resourceRva = $reader.ReadUInt32()
      $resourceSize = $reader.ReadUInt32()
      $hasResourceDirectory = ($resourceRva -ne 0 -and $resourceSize -ne 0)
      if (-not $hasResourceDirectory) { throw "$Label has no PE resource directory." }
    }
  } finally {
    $reader.Dispose()
  }
  return [pscustomobject]@{ peMachine = 'AMD64'; peFormat = 'PE32+'; resourceDirectoryPresent = $hasResourceDirectory }
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

function Assert-FirstLaunchOwnedLiveStageRoot {
  param([Parameter(Mandatory = $true)][string] $StageRoot, [Parameter(Mandatory = $true)][string] $OwnerToken)
  $identity = Get-FirstLaunchGateIdentity
  $expectedName = 'morrow-e003-g23-stage-' + [string]$identity.gate.sourceSha + '-' + [string]$identity.gate.gateRunId + '-1'
  $expectedRoot = Join-Path ([string]$identity.runner.tempRoot) $expectedName
  $comparison = [StringComparison]::OrdinalIgnoreCase
  if (-not [string]::Equals([IO.Path]::GetFullPath($StageRoot), $expectedRoot, $comparison)) {
    throw 'The owned package stage is not the exact fixed child of the current RUNNER_TEMP.'
  }
  $claim = Assert-FirstLaunchStageClaim $expectedRoot $OwnerToken
  return $claim.stageRoot
}

function Get-FirstLaunchStageOwnerPaths {
  param([Parameter(Mandatory = $true)][string] $StageRoot)
  if ([string]::IsNullOrWhiteSpace($StageRoot) -or -not [IO.Path]::IsPathRooted($StageRoot)) {
    throw 'The owned Stage path must be absolute.'
  }
  $full = [IO.Path]::GetFullPath($StageRoot)
  $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  if (-not [string]::Equals($StageRoot, $full, $comparison)) { throw 'The owned Stage path is not canonical.' }
  $parent = [IO.Path]::GetDirectoryName($full)
  if ([string]::IsNullOrEmpty($parent) -or -not [IO.Directory]::Exists($parent)) { throw 'The owned Stage parent directory is unavailable.' }
  [void](Assert-FirstLaunchNoReparsePath $parent 'Owned Stage parent')
  return [pscustomobject]@{
    root = $full
    parent = $parent
    marker = Join-Path $full $script:FirstLaunchStageOwnerMarkerName
    claim = $full + '.claim'
  }
}

function New-FirstLaunchStageClaim {
  param([Parameter(Mandatory = $true)][string] $StageRoot, [scriptblock] $DirectoryCreator)
  $paths = Get-FirstLaunchStageOwnerPaths $StageRoot
  [void](Assert-FirstLaunchNewDirectoryPath $paths.root 'First-launch Stage root')
  $token = [guid]::NewGuid().ToString('N').ToLowerInvariant()
  $tokenBytes = [Text.UTF8Encoding]::new($false).GetBytes($token)
  Write-FirstLaunchNewFile $paths.claim $tokenBytes
  $rootCreatedByThisCall = $false
  try {
    if ($null -ne $DirectoryCreator) {
      & $DirectoryCreator $paths.root
    } else {
      $nativeType = Get-FirstLaunchBoundedProcessType
      $nativeType::CreateDirectoryExclusive($paths.root)
    }
    $rootCreatedByThisCall = $true
    [void](Assert-FirstLaunchNoReparsePath $paths.root 'Claimed first-launch Stage root')
    Write-FirstLaunchNewFile $paths.marker $tokenBytes
    return (Assert-FirstLaunchStageClaim $paths.root $token)
  } catch {
    if ($rootCreatedByThisCall) {
      try { Remove-FirstLaunchOwnedStageRoot $paths.root $token -AllowEmptyRoot } catch { }
      throw 'The private first-launch Stage directory could not be claimed safely.'
    }
    try { Remove-FirstLaunchStageClaimFile $paths.root $token } catch { }
    if ([IO.File]::Exists($paths.root) -or [IO.Directory]::Exists($paths.root)) {
      throw 'The first-launch Stage root appeared before exclusive creation and was preserved.'
    }
    throw 'The private first-launch Stage directory could not be claimed safely.'
  }
}

function Assert-FirstLaunchStageClaim {
  param(
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [Parameter(Mandatory = $true)][string] $OwnerToken
  )
  if ($OwnerToken -notmatch '^[0-9a-f]{32}$') { throw 'The private first-launch Stage owner token is malformed.' }
  $paths = Get-FirstLaunchStageOwnerPaths $StageRoot
  if (-not [IO.Directory]::Exists($paths.root)) { throw 'The claimed first-launch Stage directory is missing.' }
  [void](Assert-FirstLaunchNoReparsePath $paths.root 'Claimed first-launch Stage root')
  foreach ($file in @($paths.claim, $paths.marker)) {
    [void](Assert-FirstLaunchNoReparsePath $file 'First-launch Stage owner signal')
    if (-not [IO.File]::Exists($file) -or [IO.Directory]::Exists($file) -or
        [IO.File]::ReadAllText($file) -cne $OwnerToken) {
      throw 'The first-launch Stage owner signal is missing or does not match its exact token.'
    }
  }
  return [pscustomobject]@{ stageRoot = $paths.root; markerPath = $paths.marker; claimPath = $paths.claim; token = $OwnerToken }
}

function Assert-FirstLaunchOwnedStageTree {
  param([Parameter(Mandatory = $true)][string] $StageRoot)
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($StageRoot)
  $allPaths = [Collections.Generic.List[string]]::new()
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    [void](Assert-FirstLaunchNoReparsePath $current 'Owned Stage cleanup path')
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Owned Stage cleanup refuses reparse points.' }
    $allPaths.Add($current)
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) { $pending.Push($entry) }
    }
  }
  return $allPaths.ToArray()
}

function Remove-FirstLaunchStageClaimFile {
  param([Parameter(Mandatory = $true)][string] $StageRoot, [Parameter(Mandatory = $true)][string] $OwnerToken)
  $paths = Get-FirstLaunchStageOwnerPaths $StageRoot
  [void](Assert-FirstLaunchNoReparsePath $paths.claim 'First-launch Stage claim signal')
  if (-not [IO.File]::Exists($paths.claim) -or [IO.File]::ReadAllText($paths.claim) -cne $OwnerToken) {
    throw 'Stage claim release refused because the exact sidecar owner signal is absent.'
  }
  [IO.File]::Delete($paths.claim)
}

function Remove-FirstLaunchOwnedStageRoot {
  param(
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [Parameter(Mandatory = $true)][string] $OwnerToken,
    [switch] $AllowEmptyRoot
  )
  if ($OwnerToken -notmatch '^[0-9a-f]{32}$') { throw 'The Stage cleanup owner token is malformed.' }
  $paths = Get-FirstLaunchStageOwnerPaths $StageRoot
  [void](Assert-FirstLaunchNoReparsePath $paths.claim 'First-launch Stage claim signal')
  if (-not [IO.File]::Exists($paths.claim) -or [IO.File]::ReadAllText($paths.claim) -cne $OwnerToken) {
    throw 'Stage cleanup refused because the exact sidecar owner signal is absent.'
  }
  if ([IO.Directory]::Exists($paths.root)) {
    [void](Assert-FirstLaunchNoReparsePath $paths.root 'Owned Stage cleanup root')
    if ([IO.File]::Exists($paths.marker)) {
      [void](Assert-FirstLaunchNoReparsePath $paths.marker 'First-launch Stage owner marker')
      if ([IO.File]::ReadAllText($paths.marker) -cne $OwnerToken) { throw 'Stage cleanup refused because its owner marker changed.' }
    } elseif (-not $AllowEmptyRoot -or @([IO.Directory]::EnumerateFileSystemEntries($paths.root)).Count -ne 0) {
      throw 'Stage cleanup refused because an unmarked Stage directory is not empty.'
    }
    $tree = @(Assert-FirstLaunchOwnedStageTree $paths.root)
    foreach ($entryPath in $tree) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) {
        [IO.File]::SetAttributes($entryPath, $attributes -band (-bnot [IO.FileAttributes]::ReadOnly))
      }
    }
    [IO.Directory]::Delete($paths.root, $true)
    if ([IO.Directory]::Exists($paths.root) -or [IO.File]::Exists($paths.root)) { throw 'Owned Stage cleanup did not remove its exact root.' }
  }
  [IO.File]::Delete($paths.claim)
}

function Complete-FirstLaunchStageClaim {
  param([Parameter(Mandatory = $true)][string] $StageRoot, [Parameter(Mandatory = $true)][string] $OwnerToken)
  $claim = Assert-FirstLaunchStageClaim $StageRoot $OwnerToken
  [IO.File]::Delete($claim.claimPath)
}

function Invoke-FirstLaunchOwnedStage {
  param(
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [Parameter(Mandatory = $true)][scriptblock] $Action,
    [object[]] $ActionArguments = @()
  )
  $claim = New-FirstLaunchStageClaim $StageRoot
  try {
    $result = & $Action $claim @ActionArguments
    Complete-FirstLaunchStageClaim $claim.stageRoot $claim.token
    return $result
  } catch {
    try { Remove-FirstLaunchOwnedStageRoot $claim.stageRoot $claim.token } catch {
      throw 'The Stage failed and its exact owner check prevented unsafe temporary cleanup.'
    }
    throw
  }
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
  $pe = Assert-FirstLaunchPeX64 -ExecutablePath (Join-Path $PackageRoot 'morrow.exe') -Label 'Pinned morrow.exe' -RequireResourceDirectory
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
    [scriptblock] $Transport,
    [string] $StageOwnerToken
  )
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'A GitHub API token is required for the pinned package download.' }
  if ($null -eq $Transport) {
    if ([string]::IsNullOrWhiteSpace($StageOwnerToken)) {
      throw 'Live artifact staging requires the caller-held exact Stage owner lease.'
    }
    $pinnedCandidate = Copy-FirstLaunchValue $script:FirstLaunchCandidate
    $pinnedInventory = Copy-FirstLaunchValue $script:PinnedPackageInventory
    if (-not (Test-FirstLaunchSameJsonValue $Candidate $pinnedCandidate) -or
        -not (Test-FirstLaunchSameJsonValue $ExpectedInventory $pinnedInventory)) {
      throw 'Live downloads are restricted to the compiled 2.2 candidate and its canonical inventory.'
    }
    $Candidate = $pinnedCandidate
    $ExpectedInventory = $pinnedInventory
    $stageRoot = Assert-FirstLaunchOwnedLiveStageRoot $StageRoot $StageOwnerToken
  } else {
    if (-not [string]::IsNullOrEmpty($StageOwnerToken)) { throw 'Hermetic package transport cannot claim a live Stage owner lease.' }
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
  if ($null -ne $Transport) {
    [void][IO.Directory]::CreateDirectory($stageRoot)
    [void](Assert-FirstLaunchNoReparsePath $stageRoot 'First-launch package stage')
  } else {
    [void](Assert-FirstLaunchStageClaim $stageRoot $StageOwnerToken)
  }
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

function Get-FirstLaunchUtcMilliseconds {
  param([DateTimeOffset] $Value = [DateTimeOffset]::UtcNow)
  return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-FirstLaunchPreciseCatalogUtc {
  param([Parameter(Mandatory = $true)][string] $Value, [Parameter(Mandatory = $true)][string] $Label)
  $format = "yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'"
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTimeOffset]::TryParseExact(
      $Value, $format, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed
    )) {
    throw "$Label must be an exact UTC timestamp with seven fractional digits."
  }
  $canonical = $parsed.UtcDateTime.ToString($format, [Globalization.CultureInfo]::InvariantCulture)
  if ($canonical -cne $Value) { throw "$Label is not in canonical UTC form." }
  return [pscustomobject]@{ Text = $canonical; Value = $parsed }
}

function Assert-FirstLaunchCanonicalWindowsPath {
  param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.Contains('/') -or $Path.EndsWith('\')) {
    throw "$Label must be a normalized absolute Windows drive path."
  }
  $segments = $Path.Substring(3).Split('\')
  if ($segments.Count -eq 0 -or @($segments | Where-Object {
        [string]::IsNullOrEmpty($_) -or $_ -ceq '.' -or $_ -ceq '..' -or $_.EndsWith('.') -or $_.EndsWith(' ') -or
          $_.Contains(':') -or $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$' -or
          $_ -match '^(?i:[A-Z0-9]{1,6}~[1-9](?:\.[A-Z0-9]{0,3})?)$'
      }).Count -gt 0) {
    throw "$Label contains a noncanonical, reserved, or aliased Windows path component."
  }
  return $Path
}

function Test-FirstLaunchWindowsPathsOverlap {
  param([Parameter(Mandatory = $true)][string] $Left, [Parameter(Mandatory = $true)][string] $Right)
  $leftPath = $Left.TrimEnd('\').ToLowerInvariant()
  $rightPath = $Right.TrimEnd('\').ToLowerInvariant()
  return ($leftPath -ceq $rightPath -or $leftPath.StartsWith($rightPath + '\', [StringComparison]::Ordinal) -or
    $rightPath.StartsWith($leftPath + '\', [StringComparison]::Ordinal))
}

function Get-FirstLaunchGateIdentity {
  param([System.Collections.IDictionary] $Environment = [Environment]::GetEnvironmentVariables())
  $repository = [string]$Environment['GITHUB_REPOSITORY']
  $ref = [string]$Environment['GITHUB_REF']
  $workflowRef = [string]$Environment['GITHUB_WORKFLOW_REF']
  $sourceSha = ([string]$Environment['GITHUB_SHA']).ToLowerInvariant()
  $gateRunId = [string]$Environment['GITHUB_RUN_ID']
  $gateRunAttempt = [string]$Environment['GITHUB_RUN_ATTEMPT']
  $event = [string]$Environment['GITHUB_EVENT_NAME']
  $os = [string]$Environment['RUNNER_OS']
  $arch = [string]$Environment['RUNNER_ARCH']
  $tempRoot = [string]$Environment['RUNNER_TEMP']
  $workspace = [string]$Environment['GITHUB_WORKSPACE']

  if ($repository -cne $script:FirstLaunchGateRepository -or $ref -cne $script:FirstLaunchGateRef -or
      $workflowRef -cne $script:FirstLaunchWorkflowRef -or $event -cne $script:FirstLaunchGateEvent) {
    throw 'The current GitHub run is outside the pinned first-launch gate identity.'
  }
  if ($sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'The current gate source SHA is malformed.' }
  if ($gateRunId -notmatch '^[1-9][0-9]{0,19}$' -or
      $gateRunId -ceq [string]$script:FirstLaunchCandidate.buildRunId) {
    throw 'The current gate RunID is invalid or aliases the candidate build RunID.'
  }
  if ($gateRunAttempt -cne '1') { throw 'The first-launch gate requires attempt 1.' }
  if ($os -cne 'Windows' -or $arch -cne 'X64' -or
      -not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    throw 'The first-launch Stage requires a 64-bit Windows runner process.'
  }
  [void](Assert-FirstLaunchCanonicalWindowsPath $tempRoot 'RUNNER_TEMP')
  $tempFull = [IO.Path]::GetFullPath($tempRoot).TrimEnd('\')
  if ($tempFull -notmatch '^[A-Za-z]:\\[^:]*$' -or -not [IO.Directory]::Exists($tempFull) -or
      -not [string]::Equals($tempFull, $tempRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RUNNER_TEMP must be an existing canonical Windows-local path.'
  }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($tempFull))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'RUNNER_TEMP must reside on a fixed local drive.' }
  [void](Assert-NoReparsePath $tempFull 'RUNNER_TEMP')
  [void](Assert-FirstLaunchCanonicalWindowsPath $workspace 'GITHUB_WORKSPACE')
  $workspaceFull = [IO.Path]::GetFullPath($workspace).TrimEnd('\')
  if (-not [IO.Directory]::Exists($workspaceFull) -or
      -not [string]::Equals($workspaceFull, $workspace.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'GITHUB_WORKSPACE must be an existing canonical Windows-local path.'
  }
  if (Test-FirstLaunchWindowsPathsOverlap $tempFull $workspaceFull) {
    throw 'RUNNER_TEMP must be isolated from GITHUB_WORKSPACE.'
  }
  [void](Assert-NoReparsePath $workspaceFull 'GITHUB_WORKSPACE')
  return [pscustomobject]@{
    gate = [ordered]@{
      repository = $repository
      ref = $ref
      workflowPath = $script:FirstLaunchWorkflowPath
      workflowRef = $workflowRef
      sourceSha = $sourceSha
      gateRunId = $gateRunId
      gateRunAttempt = $gateRunAttempt
      event = $event
    }
    runner = [ordered]@{ os = $os; arch = $arch; tempRoot = $tempFull; workspace = $workspaceFull }
  }
}

function Get-FirstLaunchCandidateBuildDto {
  $candidate = $script:FirstLaunchCandidate
  return [ordered]@{
    repository = [string]$candidate.repository
    branch = [string]$candidate.branch
    sourceSha = [string]$candidate.sourceSha
    sourceTree = [string]$candidate.sourceTree
    candidateBuildRunId = [string]$candidate.buildRunId
    candidateBuildRunAttempt = [string]$candidate.buildRunAttempt
    artifact = [ordered]@{
      id = [string]$candidate.artifact.id
      name = [string]$candidate.artifact.name
      digest = [string]$candidate.artifact.digest
      sizeBytes = [long]$candidate.artifact.sizeBytes
      expiresAtUtc = [string]$candidate.artifact.expiresAtUtc
    }
    package = [ordered]@{
      outerSha256 = [string]$candidate.package.outerSha256
      innerName = [string]$candidate.package.innerName
      innerSizeBytes = [long]$candidate.package.innerSizeBytes
      innerSha256 = [string]$candidate.package.innerSha256
      innerEntryCount = [int]$candidate.package.innerEntryCount
      innerTotalBytes = [long]$candidate.package.innerTotalBytes
      fileInventoryCount = [int]$candidate.package.fileInventoryCount
      buildInfoSizeBytes = [long]$candidate.package.buildInfoSizeBytes
      buildInfoSha256 = [string]$candidate.package.buildInfoSha256
      sha256SumsSizeBytes = [long]$candidate.package.sha256SumsSizeBytes
      sha256SumsSha256 = [string]$candidate.package.sha256SumsSha256
      canonicalInventorySha256 = [string]$candidate.package.canonicalInventorySha256
      launcherSha256 = [string]$candidate.package.launcherSha256
      launcherCmdSha256 = [string]$candidate.package.launcherCmdSha256
      mcpResourceSha256 = [string]$candidate.package.mcpResourceSha256
      overlayPath = [string]$candidate.package.overlayPath
      overlaySha256 = [string]$candidate.package.overlaySha256
      mcpResourceSource = [string]$candidate.package.mcpResourceSource
      mcpResourceTarget = [string]$candidate.package.mcpResourceTarget
      demoVaultPath = [string]$candidate.package.demoVaultPath
      demoVaultSha256 = [string]$candidate.package.demoVaultSha256
      sourceAuditSha256 = [string]$candidate.package.sourceAuditSha256
    }
    application = [ordered]@{
      version = [string]$candidate.package.applicationVersion
      executableSizeBytes = [long]$candidate.package.executableSizeBytes
      executableSha256 = [string]$candidate.package.executableSha256
      pilotIdentifier = [string]$candidate.package.pilotIdentifier
      appGUIWindowsTested = $false
    }
  }
}

function Get-FirstLaunchWebView2RegistryValue {
  param(
    [Parameter(Mandatory = $true)][Microsoft.Win32.RegistryHive] $Hive,
    [Parameter(Mandatory = $true)][string] $KeyPath
  )
  $label = if ($Hive -eq [Microsoft.Win32.RegistryHive]::LocalMachine) { 'HKLM64' } else { 'HKCU64' }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.OpenSubKey($KeyPath, $false)
    if ($null -eq $key) {
      return [pscustomobject]@{ Present = $false; Value = $null; Kind = $null; RegistryPath = "$label\$KeyPath" }
    }
    try {
      $value = $key.GetValue('pv', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = if ($key.GetValueKind('pv') -eq [Microsoft.Win32.RegistryValueKind]::String) { 'REG_SZ' } else { 'OTHER' }
      return [pscustomobject]@{ Present = $true; Value = $value; Kind = $kind; RegistryPath = "$label\$KeyPath" }
    } catch [System.ArgumentException] {
      return [pscustomobject]@{ Present = $true; Value = $null; Kind = 'MISSING_PV'; RegistryPath = "$label\$KeyPath" }
    } finally {
      $key.Dispose()
    }
  } finally {
    $base.Dispose()
  }
}

function Get-FirstLaunchWebView2Observation {
  param([scriptblock] $RegistryReader)
  if ($null -eq $RegistryReader -and
      (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess)) {
    throw 'WebView2 observation requires a 64-bit Windows process and operating system.'
  }
  $machinePath = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + $script:FirstLaunchWebView2Guid
  $userPath = 'Software\Microsoft\EdgeUpdate\Clients\' + $script:FirstLaunchWebView2Guid
  if ($null -eq $RegistryReader) {
    $candidates = @(
      (Get-FirstLaunchWebView2RegistryValue ([Microsoft.Win32.RegistryHive]::LocalMachine) $machinePath),
      (Get-FirstLaunchWebView2RegistryValue ([Microsoft.Win32.RegistryHive]::CurrentUser) $userPath)
    )
  } else {
    $candidates = @(
      (& $RegistryReader ([pscustomobject]@{ hive = 'LocalMachine'; view = 'Registry64'; path = $machinePath; registryPath = ('HKLM64\' + $machinePath) })),
      (& $RegistryReader ([pscustomobject]@{ hive = 'CurrentUser'; view = 'Registry64'; path = $userPath; registryPath = ('HKCU64\' + $userPath) }))
    )
  }
  $present = @($candidates | Where-Object { $_.Present })
  if ($present.Count -eq 0) { throw 'WebView2 Evergreen Runtime pv was not found in the approved 64-bit registry locations.' }
  $versions = [Collections.Generic.List[string]]::new()
  $sources = [Collections.Generic.List[object]]::new()
  foreach ($candidate in $present) {
    if ([string]$candidate.Kind -cne 'REG_SZ' -or [string]$candidate.Value -notmatch '^\d+\.\d+\.\d+\.\d+$') {
      throw 'A present WebView2 registry key has a missing, non-string, or malformed pv value.'
    }
    $parsedVersion = $null
    if (-not [version]::TryParse([string]$candidate.Value, [ref]$parsedVersion) -or $parsedVersion -le [version]'0.0.0.0') {
      throw 'A present WebView2 registry key has an invalid or zero pv value.'
    }
    $versions.Add([string]$candidate.Value)
    $sources.Add([ordered]@{ registryPath = [string]$candidate.RegistryPath; version = [string]$candidate.Value })
  }
  if (@($versions | Select-Object -Unique).Count -ne 1) {
    throw 'The machine/user WebView2 pv values disagree; Stage refuses ambiguous runtime selection.'
  }
  return [pscustomobject]@{
    version = [string]$versions[0]
    observedAtUtc = Get-FirstLaunchUtcMilliseconds
    sources = @($sources.ToArray())
  }
}

function Get-FirstLaunchSha256Bytes {
  param([Parameter(Mandatory = $true)][byte[]] $Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function ConvertFrom-FirstLaunchEdgeCatalog {
  param([Parameter(Mandatory = $true)][byte[]] $CatalogBytes, [Parameter(Mandatory = $true)][string] $RuntimeVersion)
  if ($RuntimeVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'The observed WebView2 pv is not a four-component version.' }
  if ($CatalogBytes.Length -le 0 -or $CatalogBytes.LongLength -gt $script:FirstLaunchMaxEdgeCatalogBytes) {
    throw 'The official EdgeDriver catalog is empty or exceeds its byte limit.'
  }
  try { $catalogJson = [Text.UTF8Encoding]::new($false, $true).GetString($CatalogBytes) }
  catch { throw 'The official EdgeDriver catalog is not valid UTF-8.' }
  try {
    $catalog = ConvertFrom-Json -InputObject $catalogJson -AsHashtable -NoEnumerate -DateKind String -ErrorAction Stop
  } catch { throw 'The official EdgeDriver catalog is malformed JSON.' }
  if ($catalog -isnot [Collections.IDictionary]) { throw 'The official EdgeDriver catalog root is not an object.' }
  $rootKeys = @($catalog.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
  if ($rootKeys.Count -ne 2 -or $rootKeys[0] -cne 'generatedAt' -or $rootKeys[1] -cne 'items') {
    throw 'The official EdgeDriver catalog has an unexpected top-level schema.'
  }
  if ($catalog['generatedAt'] -isnot [string]) { throw 'The official EdgeDriver catalog has no generatedAt timestamp.' }
  $generated = ConvertTo-FirstLaunchPreciseCatalogUtc ([string]$catalog['generatedAt']) 'EdgeDriver catalog generatedAt'
  $rawItems = $catalog['items']
  if ($rawItems -isnot [Collections.IList] -or $rawItems -is [string]) {
    throw 'The official EdgeDriver catalog items field is not an array.'
  }
  $items = @($rawItems)
  if ($items.Count -le 0 -or $items.Count -gt $script:FirstLaunchMaxEdgeCatalogItems) {
    throw 'The official EdgeDriver catalog item count is empty or exceeds its limit.'
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $parsedItems = [Collections.Generic.List[object]]::new()
  foreach ($item in $items) {
    if ($item -isnot [Collections.IDictionary]) { throw 'The official EdgeDriver catalog contains a non-object item.' }
    $itemKeys = @($item.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    if ($itemKeys.Count -ne 4 -or $itemKeys[0] -cne 'contentLength' -or $itemKeys[1] -cne 'isDirectory' -or
        $itemKeys[2] -cne 'lastModified' -or $itemKeys[3] -cne 'name') {
      throw 'The official EdgeDriver catalog contains an unexpected item schema.'
    }
    if ($item['isDirectory'] -isnot [bool] -or $item['isDirectory']) {
      throw 'The official EdgeDriver catalog item is not a plain file.'
    }
    if ($item['contentLength'] -isnot [int] -and $item['contentLength'] -isnot [long]) {
      throw 'The official EdgeDriver catalog item has a non-integer contentLength.'
    }
    $contentLength = [long]$item['contentLength']
    if ($contentLength -le 0) { throw 'The official EdgeDriver catalog item has an empty or negative contentLength.' }
    if ($item['lastModified'] -isnot [string]) { throw 'The official EdgeDriver catalog item has no lastModified timestamp.' }
    $modified = ConvertTo-FirstLaunchPreciseCatalogUtc ([string]$item['lastModified']) 'EdgeDriver item lastModified'
    if ($modified.Value -gt $generated.Value) { throw 'An EdgeDriver catalog item modification time postdates catalog generation.' }
    if ($item['name'] -isnot [string]) { throw 'The official EdgeDriver catalog item name is not text.' }
    $name = [string]$item['name']
    $kind = $null
    $versionText = ''
    $fileName = ''
    $parsedVersion = $null
    $driverMatch = [regex]::Match($name, '^(?<version>\d+\.\d+\.\d+\.\d+)/(?<file>edgedriver_(?<architecture>arm64|win32|win64|linux64|mac64|mac64_m1)\.zip)$')
    if ($driverMatch.Success) {
      $kind = 'driverArchive'
      $versionText = $driverMatch.Groups['version'].Value
      $fileName = $driverMatch.Groups['file'].Value
      if (-not [version]::TryParse($versionText, [ref]$parsedVersion)) { throw 'The official EdgeDriver catalog has an invalid version path.' }
    } elseif ($name -cmatch '^wpt-mojom/\d+\.\d+\.\d+\.\d+/linux64/mojojs\.zip$') {
      $kind = 'wptArchive'
    } elseif ($name -cmatch '^LATEST_(?:BETA|CANARY|DEV|EXTENDEDSTABLE|STABLE|RELEASE_\d+(?:_(?:LINUX|MACOS|WINDOWS))?)$') {
      $kind = 'versionAlias'
    } elseif ($name -cin @('EMPTY', 'EULA', 'credits.html', 'listing.json')) {
      $kind = 'catalogMetadata'
    } else {
      throw 'The official EdgeDriver catalog contains an unknown or malformed item name.'
    }
    if (-not $seen.Add($name)) { throw 'The official EdgeDriver catalog repeats an item name.' }
    $parsedItems.Add([pscustomobject]@{
      Name = $name
      Kind = $kind
      FileName = $fileName
      Version = $versionText
      ParsedVersion = $parsedVersion
      ContentLength = $contentLength
      LastModified = $modified.Text
    })
  }
  $runtimeParsed = $null
  if (-not [version]::TryParse($RuntimeVersion, [ref]$runtimeParsed)) { throw 'The observed WebView2 pv is invalid.' }
  $runtimeBuild = $runtimeParsed.Major.ToString() + '.' + $runtimeParsed.Minor + '.' + $runtimeParsed.Build
  $candidates = @($parsedItems.ToArray() | Where-Object {
    $_.Kind -ceq 'driverArchive' -and $_.FileName -ceq 'edgedriver_win64.zip' -and
      $_.ParsedVersion.Major -eq $runtimeParsed.Major -and $_.ParsedVersion.Minor -eq $runtimeParsed.Minor -and
      $_.ParsedVersion.Build -eq $runtimeParsed.Build
  })
  if ($candidates.Count -eq 0) { throw 'The official EdgeDriver catalog has no x64 driver matching the observed WebView2 pv build.' }
  $selected = @($candidates | Sort-Object -Property ParsedVersion -Descending)[0]
  if ($selected.ContentLength -gt $script:FirstLaunchMaxEdgeArchiveBytes) {
    throw 'The selected EdgeDriver archive exceeds its download byte limit.'
  }
  $downloadUrl = $script:FirstLaunchEdgeRootUrl + '/' + $selected.Version + '/edgedriver_win64.zip'
  return [pscustomobject]@{
    version = [string]$selected.Version
    runtimeVersion = $RuntimeVersion
    compatibleFirstThreeComponents = $runtimeBuild
    sourcePageUrl = $script:FirstLaunchEdgeSourcePageUrl
    sourceCatalogUrl = $script:FirstLaunchEdgeCatalogUrl
    downloadUrl = $downloadUrl
    catalogGeneratedAtUtc = $generated.Text
    catalogSizeBytes = [long]$CatalogBytes.LongLength
    catalogItemCount = [int]$items.Count
    catalogSha256 = Get-FirstLaunchSha256Bytes $CatalogBytes
    selectedLastModified = [string]$selected.LastModified
    expectedArchiveBytes = [long]$selected.ContentLength
  }
}

function Get-FirstLaunchBoundedProcessType {
  if ('MorrowFirstLaunch.BoundedProcessRunner' -as [type]) { return [MorrowFirstLaunch.BoundedProcessRunner] }
  $source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace MorrowFirstLaunch {
  public sealed class BoundedProcessResult {
    public int ExitCode { get; set; }
    public string StandardOutput { get; set; }
    public string StandardError { get; set; }
    public bool TimedOut { get; set; }
    public bool OutputLimitExceeded { get; set; }
  }

  public static class BoundedProcessRunner {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateDirectoryW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryWindows(string path, IntPtr securityAttributes);

    [DllImport("libc", SetLastError = true, EntryPoint = "mkdir")]
    private static extern int CreateDirectoryLinux([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);

    public static void CreateDirectoryExclusive(string path) {
      if (String.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path))
        throw new ArgumentException("The exclusive directory path must be absolute.", "path");
      if (Path.DirectorySeparatorChar == '\\') {
        if (!CreateDirectoryWindows(path, IntPtr.Zero)) {
          int error = Marshal.GetLastWin32Error();
          if (error == 183) throw new IOException("The Stage root already exists.", new Win32Exception(error));
          throw new Win32Exception(error, "The Stage root could not be created exclusively.");
        }
        return;
      }
      if (Path.DirectorySeparatorChar == '/' && RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) {
        if (CreateDirectoryLinux(path, 0x1C0) != 0) {
          int error = Marshal.GetLastWin32Error();
          if (error == 17) throw new IOException("The Stage root already exists.", new Win32Exception(error));
          throw new Win32Exception(error, "The Stage root could not be created exclusively.");
        }
        return;
      }
      throw new PlatformNotSupportedException("Exclusive Stage directory creation is supported only on Windows and Linux.");
    }

    private static async Task<byte[]> ReadBoundedAsync(
      Stream stream,
      Func<int, bool> reserveOutput,
      Action onLimit,
      CancellationToken cancellationToken
    ) {
      using (var captured = new MemoryStream()) {
        var buffer = new byte[2048];
        while (true) {
          int read;
          try {
            read = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
          } catch (OperationCanceledException) {
            break;
          } catch (ObjectDisposedException) {
            break;
          } catch (IOException) {
            break;
          }
          if (read <= 0) break;
          if (!reserveOutput(read)) {
            onLimit();
            break;
          }
          captured.Write(buffer, 0, read);
        }
        return captured.ToArray();
      }
    }

    private static string Decode(byte[] bytes) {
      return new UTF8Encoding(false, true).GetString(bytes);
    }

    private static long DeadlineAfterMilliseconds(long startedAt, int milliseconds) {
      long ticks = (long)Math.Ceiling(milliseconds * (double)Stopwatch.Frequency / 1000.0);
      if (ticks <= 0) ticks = 1;
      return startedAt > long.MaxValue - ticks ? long.MaxValue : startedAt + ticks;
    }

    private static int RemainingDelayMilliseconds(long deadline) {
      long ticks = deadline - Stopwatch.GetTimestamp();
      if (ticks <= 0) return 0;
      double milliseconds = Math.Ceiling(ticks * 1000.0 / Stopwatch.Frequency);
      return milliseconds >= int.MaxValue ? int.MaxValue : Math.Max(1, (int)milliseconds);
    }

    private static bool WaitUntil(Task completion, long deadline) {
      if (completion.IsCompleted) return Stopwatch.GetTimestamp() <= deadline;
      int delayMilliseconds = RemainingDelayMilliseconds(deadline);
      if (delayMilliseconds <= 0) return false;
      Task winner = Task.WhenAny(completion, Task.Delay(delayMilliseconds)).GetAwaiter().GetResult();
      return winner == completion && Stopwatch.GetTimestamp() <= deadline;
    }

    private static bool WaitUntilOrSignal(Task completion, Task signal, long deadline) {
      if (completion.IsCompleted) return Stopwatch.GetTimestamp() <= deadline;
      if (signal.IsCompleted) return false;
      int delayMilliseconds = RemainingDelayMilliseconds(deadline);
      if (delayMilliseconds <= 0) return false;
      Task winner = Task.WhenAny(completion, signal, Task.Delay(delayMilliseconds)).GetAwaiter().GetResult();
      return winner == completion && Stopwatch.GetTimestamp() <= deadline;
    }

    private static void TryKillOwnedTree(Process process) {
      try {
        if (!process.HasExited) process.Kill(true);
      } catch {
        try { process.Kill(true); } catch { }
      }
    }

    private static void CloseRedirectedPipes(Process process) {
      try { process.StandardOutput.Close(); } catch { }
      try { process.StandardError.Close(); } catch { }
    }

    private static void ObserveIfFaulted(Task task) {
      task.ContinueWith(
        completed => { var ignored = completed.Exception; },
        CancellationToken.None,
        TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
        TaskScheduler.Default
      );
    }

    public static BoundedProcessResult Run(
      string executable,
      string[] arguments,
      string workingDirectory,
      IDictionary<string, string> environment,
      int timeoutMilliseconds,
      int outputLimitBytes
    ) {
      if (timeoutMilliseconds <= 0 || outputLimitBytes <= 0) throw new ArgumentOutOfRangeException();
      long deadline = DeadlineAfterMilliseconds(Stopwatch.GetTimestamp(), timeoutMilliseconds);
      using (var process = new Process()) {
        var start = new ProcessStartInfo {
          FileName = executable,
          WorkingDirectory = workingDirectory,
          UseShellExecute = false,
          CreateNoWindow = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
          StandardOutputEncoding = new UTF8Encoding(false, true),
          StandardErrorEncoding = new UTF8Encoding(false, true)
        };
        start.Environment.Clear();
        foreach (var pair in environment) start.Environment[pair.Key] = pair.Value;
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        process.StartInfo = start;
        if (!process.Start()) throw new InvalidOperationException("Process start returned false.");

        int outputExceeded = 0;
        var outputLimitSignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action onLimit = () => {
          if (Interlocked.Exchange(ref outputExceeded, 1) == 0) {
            outputLimitSignal.TrySetResult(true);
            TryKillOwnedTree(process);
          }
        };
        int capturedOutputBytes = 0;
        Func<int, bool> reserveOutput = count => Interlocked.Add(ref capturedOutputBytes, count) <= outputLimitBytes;
        using (var readCancellation = new CancellationTokenSource()) {
          var stdoutTask = ReadBoundedAsync(process.StandardOutput.BaseStream, reserveOutput, onLimit, readCancellation.Token);
          var stderrTask = ReadBoundedAsync(process.StandardError.BaseStream, reserveOutput, onLimit, readCancellation.Token);
          var waitTask = process.WaitForExitAsync();
          Task allTask = Task.WhenAll(waitTask, (Task)stdoutTask, (Task)stderrTask);
          bool completeByDeadline = WaitUntilOrSignal(allTask, outputLimitSignal.Task, deadline);
          bool timedOut = !completeByDeadline && Volatile.Read(ref outputExceeded) == 0;
          if (!completeByDeadline) {
            TryKillOwnedTree(process);
            readCancellation.Cancel();
            CloseRedirectedPipes(process);
            long cleanupDeadline = DeadlineAfterMilliseconds(Stopwatch.GetTimestamp(), 300);
            if (!WaitUntil(allTask, cleanupDeadline)) timedOut = true;
          }
          if (!allTask.IsCompleted) {
            ObserveIfFaulted(waitTask);
            ObserveIfFaulted(stdoutTask);
            ObserveIfFaulted(stderrTask);
          } else {
            allTask.GetAwaiter().GetResult();
          }
          bool exited = false;
          int exitCode = -1;
          try {
            exited = process.HasExited;
            if (exited) exitCode = process.ExitCode;
          } catch { }
          return new BoundedProcessResult {
            ExitCode = exitCode,
            StandardOutput = stdoutTask.Status == TaskStatus.RanToCompletion ? Decode(stdoutTask.GetAwaiter().GetResult()) : "",
            StandardError = stderrTask.Status == TaskStatus.RanToCompletion ? Decode(stderrTask.GetAwaiter().GetResult()) : "",
            TimedOut = timedOut || (!exited && Volatile.Read(ref outputExceeded) != 0),
            OutputLimitExceeded = Volatile.Read(ref outputExceeded) != 0
          };
        }
      }
    }
  }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  return [MorrowFirstLaunch.BoundedProcessRunner]
}

function Invoke-FirstLaunchBoundedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string[]] $Arguments,
    [Parameter(Mandatory = $true)][string] $WorkingDirectory,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary] $Environment,
    [Parameter(Mandatory = $true)][int] $TimeoutMs,
    [Parameter(Mandatory = $true)][int] $MaximumOutputBytes,
    [scriptblock] $ProcessRunner,
    [string] $StageRoot,
    [string] $StageOwnerToken,
    [ValidateSet('cargo', 'edge-version')][string] $ProcessRole,
    [scriptblock] $JobSessionFactory,
    [string] $ExpectedExecutableSha256 = ''
  )
  $request = [pscustomobject]@{
    executable = $Executable
    arguments = @($Arguments)
    workingDirectory = $WorkingDirectory
    environment = $Environment
    timeoutMs = $TimeoutMs
    maximumOutputBytes = $MaximumOutputBytes
  }
  if ($null -ne $ProcessRunner) {
    try { $result = & $ProcessRunner $request }
    catch { throw 'The hermetic first-launch process provider failed safely.' }
    if ($null -eq $result) { throw 'The hermetic first-launch process provider returned no result.' }
    if ([bool]$result.TimedOut) { throw 'The bounded first-launch child process exceeded its deadline and was stopped.' }
    if ([bool]$result.OutputLimitExceeded) { throw 'The bounded first-launch child process exceeded its output limit and was stopped.' }
    return $result
  }
  try {
    if ([IO.Path]::DirectorySeparatorChar -eq '\' -or $null -ne $JobSessionFactory) {
      if ([string]::IsNullOrWhiteSpace($StageRoot) -or [string]::IsNullOrWhiteSpace($StageOwnerToken) -or
          [string]::IsNullOrWhiteSpace($ProcessRole)) {
        throw 'Private Job child processes require an exact owned Stage, role, and private Job boundary.'
      }
      $result = Invoke-FirstLaunchJobBoundedProcess -Executable $Executable -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory -Environment $Environment -TimeoutMs $TimeoutMs `
        -MaximumOutputBytes $MaximumOutputBytes -StageRoot $StageRoot -StageOwnerToken $StageOwnerToken `
        -ProcessRole $ProcessRole -JobSessionFactory $JobSessionFactory -ExpectedExecutableSha256 $ExpectedExecutableSha256
    } else {
      $runnerType = Get-FirstLaunchBoundedProcessType
      $result = $runnerType::Run(
        $Executable,
        [string[]]$Arguments,
        $WorkingDirectory,
        [Collections.Generic.Dictionary[string,string]]$Environment,
        $TimeoutMs,
        $MaximumOutputBytes
      )
    }
  } catch {
    throw 'The bounded first-launch child process failed safely.'
  }
  if ($result.TimedOut) { throw 'The bounded first-launch child process exceeded its deadline and was stopped.' }
  if ($result.OutputLimitExceeded) { throw 'The bounded first-launch child process exceeded its output limit and was stopped.' }
  return [pscustomobject]@{
    ExitCode = [int]$result.ExitCode
    StdOut = [string]$result.StandardOutput
    StdErr = [string]$result.StandardError
    TimedOut = [bool]$result.TimedOut
    OutputLimitExceeded = [bool]$result.OutputLimitExceeded
  }
}

function Assert-FirstLaunchPathBelowRoot {
  param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Root, [string] $Label = 'Stage child path')
  if (-not [IO.Path]::IsPathRooted($Path) -or -not [IO.Path]::IsPathRooted($Root)) { throw "$Label must use absolute paths." }
  $fullPath = [IO.Path]::GetFullPath($Path)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
  $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
  if (-not [string]::Equals($Path, $fullPath, $comparison) -or -not $fullPath.StartsWith($prefix, $comparison)) {
    throw "$Label is outside the owned Stage root or is not canonical."
  }
  [void](Assert-FirstLaunchNoReparsePath $fullPath $Label)
  return $fullPath
}

function Assert-FirstLaunchProcessShimRequest {
  param([Parameter(Mandatory = $true)][string] $RequestPath, [Parameter(Mandatory = $true)][string] $ExpectedSha256)
  if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The private process request hash is malformed.' }
  if (-not [IO.File]::Exists($RequestPath)) { throw 'The private process request file is missing.' }
  [void](Assert-FirstLaunchNoReparsePath $RequestPath 'Private process request')
  $requestInfo = Get-Item -LiteralPath $RequestPath
  if ($requestInfo.Length -le 0 -or $requestInfo.Length -gt 256KB -or (Get-Sha256 $RequestPath) -cne $ExpectedSha256) {
    throw 'The private process request is empty, oversized, or changed after its parent pinned the bytes.'
  }
  try {
    $request = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($RequestPath))) `
      -AsHashtable -NoEnumerate -DateKind String -ErrorAction Stop
  } catch { throw 'The private process request is malformed JSON.' }
  if ($request -isnot [Collections.IDictionary]) { throw 'The private process request root is not an object.' }
  $expectedKeys = @('arguments', 'environment', 'executable', 'expectedExecutableSha256', 'maximumOutputBytes',
    'requestId', 'resultPath', 'role', 'runnerToolCache', 'schema', 'stageOwnerToken', 'stageRoot', 'timeoutMs', 'workingDirectory')
  $requestKeys = @($request.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
  if ($requestKeys.Count -ne $expectedKeys.Count -or @($requestKeys | Where-Object { $_ -cnotin $expectedKeys }).Count -gt 0 -or
      @($expectedKeys | Where-Object { $_ -cnotin $requestKeys }).Count -gt 0 -or
      [string]$request.schema -cne 'morrow.e003.g23.process-request.v1') {
    throw 'The private process request has an unexpected or incomplete schema.'
  }
  $requestId = [guid]::Empty
  if ([string]$request.requestId -notmatch '^[0-9a-f]{32}$' -or
      -not [guid]::TryParseExact([string]$request.requestId, 'N', [ref]$requestId)) {
    throw 'The private process request ID is malformed.'
  }
  if ($request.arguments -isnot [Collections.IList] -or $request.arguments -is [string] -or
      $request.environment -isnot [Collections.IDictionary] -or $request.arguments.Count -gt 8 -or
      @($request.arguments | Where-Object { $_ -isnot [string] -or ([string]$_).Length -gt 4096 }).Count -gt 0) {
    throw 'The private process request arguments or environment have an invalid type or bound.'
  }
  $argumentBytes = 0
  foreach ($argument in $request.arguments) { $argumentBytes += [Text.Encoding]::UTF8.GetByteCount([string]$argument) + 1 }
  if ($argumentBytes -gt 16384) { throw 'The private process command line exceeds its bound.' }
  if ($request.timeoutMs -isnot [int] -and $request.timeoutMs -isnot [long]) { throw 'The private process timeout is not an integer.' }
  if ($request.maximumOutputBytes -isnot [int] -and $request.maximumOutputBytes -isnot [long]) { throw 'The private process output cap is not an integer.' }
  if (-not [IO.Path]::IsPathRooted([string]$request.stageRoot) -or
      -not [string]::Equals([IO.Path]::GetFullPath([string]$request.stageRoot), [string]$request.stageRoot,
        $(if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal })) -or
      [string]$request.stageOwnerToken -notmatch '^[0-9a-f]{32}$') {
    throw 'The private process request Stage identity is not canonical.'
  }
  [void](Assert-FirstLaunchStageClaim ([string]$request.stageRoot) ([string]$request.stageOwnerToken))
  $requestPathFull = Assert-FirstLaunchPathBelowRoot $RequestPath ([string]$request.stageRoot) 'Private process request'
  $workingDirectory = Assert-FirstLaunchPathBelowRoot ([string]$request.workingDirectory) ([string]$request.stageRoot) 'Private process working directory'
  if (-not [IO.Directory]::Exists($workingDirectory)) { throw 'The private process working directory does not exist.' }
  $expectedRequestPath = Join-Path $workingDirectory ('morrow-e003-g23-process-' + [string]$request.requestId + '.request.json')
  $expectedResultPath = Join-Path $workingDirectory ('morrow-e003-g23-process-' + [string]$request.requestId + '.result.json')
  if (-not [string]::Equals($requestPathFull, $expectedRequestPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetFullPath([string]$request.resultPath), $expectedResultPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The private process request or receipt path is not its exact Stage-local request ID path.'
  }
  if ([IO.File]::Exists($expectedResultPath) -or [IO.Directory]::Exists($expectedResultPath)) {
    throw 'The private process receipt path already exists.'
  }
  if ([string]$request.role -ceq 'cargo') {
    $toolCache = [string]$request.runnerToolCache
    if ([string]::IsNullOrWhiteSpace($toolCache) -or -not [IO.Path]::IsPathRooted($toolCache) -or
        -not [string]::Equals($toolCache, [IO.Path]::GetFullPath($toolCache), [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The private Cargo request does not use a canonical trusted runner tool cache.'
    }
    $toolCacheRoot = [IO.Path]::GetFullPath($toolCache).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $executable = [IO.Path]::GetFullPath([string]$request.executable)
    if (-not [string]::Equals([string]$request.executable, $executable, [StringComparison]::OrdinalIgnoreCase) -or
        -not $executable.StartsWith($toolCacheRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The private Cargo executable is outside the exact canonical runner tool cache.'
    }
    [void](Assert-FirstLaunchNoReparsePath $executable 'Scoped Cargo executable')
  } else {
    $executable = Assert-FirstLaunchPathBelowRoot ([string]$request.executable) ([string]$request.stageRoot) 'Stage-local process executable'
    [void](Assert-FirstLaunchNoReparsePath $executable 'Stage-local process executable')
  }
  if (-not [IO.File]::Exists($executable)) { throw 'The private process executable is missing.' }
  if ([string]$request.runnerToolCache -cne [string]$env:RUNNER_TOOL_CACHE) {
    throw 'The private process request does not preserve the trusted RUNNER_TOOL_CACHE value.'
  }
  if ([string]$request.environment.SystemRoot -cne [string]$env:SystemRoot -or
      [string]$request.environment.WINDIR -cne [string]$env:SystemRoot) {
    throw 'The private process target environment does not preserve the trusted Windows root.'
  }
  $envNames = @($request.environment.Keys | ForEach-Object { [string]$_ })
  if (@($envNames | Where-Object { $_ -match '^(?i:GITHUB_|ACTIONS_|AZURE_|AWS_|TOKEN|SECRET|PASSWORD|CREDENTIAL)' }).Count -gt 0) {
    throw 'The private process request contains a credential-bearing environment name.'
  }
  $arguments = @($request.arguments | ForEach-Object { [string]$_ })
  $systemRoot = [string]$env:SystemRoot
  $expectedSystemPath = [string]::Join(';', @((Join-Path $systemRoot 'System32'), $systemRoot))
  $expectedExecutableHash = [string]$request.expectedExecutableSha256
  switch ([string]$request.role) {
    'cargo' {
      $cargoHome = Join-Path ([string]$request.stageRoot) 'cargo-home'
      $targetDirectory = Join-Path ([string]$request.stageRoot) 'cargo-target'
      $expectedWork = Join-Path ([string]$request.stageRoot) 'cargo-work'
      $toolRoot = Join-Path ([string]$request.stageRoot) 'tauri-tool-stage'
      $allowed = @('CARGO_HOME', 'CARGO_NET_GIT_FETCH_WITH_CLI', 'CARGO_REGISTRIES_CRATES_IO_PROTOCOL', 'CARGO_TARGET_DIR',
        'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR', 'RUSTUP_HOME')
      if ([IO.Path]::GetFileName($executable) -cne 'cargo.exe' -or
          -not $executable.StartsWith([IO.Path]::GetFullPath([string]$request.runnerToolCache).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
          [string]$request.workingDirectory -cne $expectedWork -or
          @($envNames | Where-Object { $_ -cnotin $allowed }).Count -gt 0 -or
          @($allowed | Where-Object { $_ -cne 'RUSTUP_HOME' -and -not $request.environment.ContainsKey($_) }).Count -gt 0 -or
          [string]$request.environment.CARGO_HOME -cne $cargoHome -or [string]$request.environment.HOME -cne $cargoHome -or
          [string]$request.environment.USERPROFILE -cne $cargoHome -or [string]$request.environment.CARGO_TARGET_DIR -cne $targetDirectory -or
          [string]$request.environment.TEMP -cne $expectedWork -or [string]$request.environment.TMP -cne $expectedWork -or
          [string]$request.environment.CARGO_NET_GIT_FETCH_WITH_CLI -cne 'false' -or
          [string]$request.environment.CARGO_REGISTRIES_CRATES_IO_PROTOCOL -cne 'sparse' -or
          [string]$request.environment.GIT_CONFIG_NOSYSTEM -cne '1' -or [string]$request.environment.GIT_TERMINAL_PROMPT -cne '0' -or
          [string]$request.environment.PATH -cne ([string]::Join(';', @([IO.Path]::GetDirectoryName($executable), (Join-Path $systemRoot 'System32'), $systemRoot))) -or
          $expectedExecutableHash.Length -ne 0) {
        throw 'The private Cargo process request is outside the fixed tool-cache and credential-free profile.'
      }
      if ($arguments.Count -eq 1 -and $arguments[0] -ceq '--version') {
        $maximumTimeout = 30000
      } elseif ($arguments.Count -eq 7 -and $arguments[0] -ceq 'install' -and $arguments[1] -ceq 'tauri-driver' -and
          $arguments[2] -ceq '--version' -and $arguments[3] -ceq '2.1.0' -and $arguments[4] -ceq '--locked' -and
          $arguments[5] -ceq '--root' -and [string]::Equals($arguments[6], $toolRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $maximumTimeout = $script:FirstLaunchCargoTimeoutMs
      } elseif ($arguments.Count -eq 4 -and $arguments[0] -ceq 'install' -and $arguments[1] -ceq '--list' -and
          $arguments[2] -ceq '--root' -and [string]::Equals($arguments[3], $toolRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $maximumTimeout = 30000
      } else { throw 'The private Cargo request contains an unexpected command or argument list.' }
      if ([long]$request.timeoutMs -gt $maximumTimeout -or [long]$request.maximumOutputBytes -gt $script:FirstLaunchCargoOutputBytes) {
        throw 'The private Cargo process exceeds its operation or output bounds.'
      }
    }
    'edge-version' {
      $edgeRoot = Join-Path ([string]$request.stageRoot) 'edge-driver-stage'
      $expectedExecutable = Join-Path (Join-Path $edgeRoot 'contents') 'msedgedriver.exe'
      $allowed = @('MSEDGEDRIVER_TELEMETRY_OPTOUT', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR')
      if (-not [string]::Equals($executable, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
          [string]$request.workingDirectory -cne $edgeRoot -or $arguments.Count -ne 1 -or $arguments[0] -cne '--version' -or
          @($envNames | Where-Object { $_ -cnotin $allowed }).Count -gt 0 -or $envNames.Count -ne $allowed.Count -or
          [string]$request.environment.TEMP -cne $edgeRoot -or [string]$request.environment.TMP -cne $edgeRoot -or
          [string]$request.environment.MSEDGEDRIVER_TELEMETRY_OPTOUT -cne '1' -or
          [string]$request.environment.PATH -cne $expectedSystemPath -or
          $expectedExecutableHash -notmatch '^[0-9a-f]{64}$' -or
          [long]$request.timeoutMs -gt $script:FirstLaunchEdgeProbeTimeoutMs -or
          [long]$request.maximumOutputBytes -gt $script:FirstLaunchEdgeProbeOutputBytes) {
        throw 'The private EdgeDriver process request is outside the exact version-only profile.'
      }
    }
    default { throw 'The private process request role is not approved.' }
  }
  if ([long]$request.timeoutMs -le 0 -or [long]$request.maximumOutputBytes -le 0) {
    throw 'The private process request has invalid timeout or output limits.'
  }
  if ($expectedExecutableHash.Length -gt 0 -and (Get-Sha256 $executable) -cne $expectedExecutableHash) {
    throw 'The Stage-local EdgeDriver executable hash changed before private process launch.'
  }
  return [pscustomobject]@{
    request = $request
    requestPath = $requestPathFull
    resultPath = $expectedResultPath
    requestId = [string]$request.requestId
    stageRoot = [string]$request.stageRoot
  }
}

function Invoke-FirstLaunchProcessShim {
  param(
    [Parameter(Mandatory = $true)][string] $RequestPath,
    [Parameter(Mandatory = $true)][string] $RequestSha256,
    [Parameter(Mandatory = $true)][string] $ShimScriptSha256
  )
  if ($ShimScriptSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The private process shim source hash is malformed.' }
  $shimSource = Join-Path $PSScriptRoot 'windows-first-launch-preflight.ps1'
  [void](Assert-FirstLaunchNoReparsePath $shimSource 'Private PowerShell process shim source')
  if ((Get-Sha256 $shimSource) -cne $ShimScriptSha256) { throw 'The private PowerShell process shim source changed after its parent pinned it.' }
  $verified = Assert-FirstLaunchProcessShimRequest $RequestPath $RequestSha256
  $request = $verified.request
  $runnerType = Get-FirstLaunchBoundedProcessType
  $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($key in $request.environment.Keys) { $environment.Add([string]$key, [string]$request.environment[$key]) }
  $result = $runnerType::Run(
    [string]$request.executable,
    [string[]]@($request.arguments | ForEach-Object { [string]$_ }),
    [string]$request.workingDirectory,
    $environment,
    [int]$request.timeoutMs,
    [int]$request.maximumOutputBytes
  )
  $receipt = [ordered]@{
    schema = 'morrow.e003.g23.process-result.v1'
    requestId = $verified.requestId
    stageOwnerToken = [string]$request.stageOwnerToken
    exitCode = [int]$result.ExitCode
    stdout = [string]$result.StandardOutput
    stderr = [string]$result.StandardError
    timedOut = [bool]$result.TimedOut
    outputLimitExceeded = [bool]$result.OutputLimitExceeded
  }
  $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $receipt -Depth 6 -Compress))
  $maximumReceiptBytes = [long]$request.maximumOutputBytes * 8 + 64KB
  if ($receiptBytes.LongLength -gt $maximumReceiptBytes) { throw 'The private process result exceeded its exact serialized size bound.' }
  [void](Assert-FirstLaunchStageClaim $verified.stageRoot ([string]$request.stageOwnerToken))
  [void](Assert-FirstLaunchNoReparsePath $verified.resultPath 'Private process result')
  Write-FirstLaunchNewFile $verified.resultPath $receiptBytes
}

function Get-FirstLaunchVerifiedNativeJobHelperScriptBlock {
  param([Parameter(Mandatory = $true)][string] $HelperPath)
  if (-not [IO.Path]::IsPathRooted($HelperPath) -or
      -not [string]::Equals($HelperPath, [IO.Path]::GetFullPath($HelperPath),
        $(if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }))) {
    throw 'The private Windows Job helper path must be canonical and absolute.'
  }
  [void](Assert-FirstLaunchNoReparsePath $HelperPath 'Pinned private Windows Job helper')
  if (-not [IO.File]::Exists($HelperPath)) { throw 'The pinned private Windows Job helper is missing.' }
  $helperBytes = [IO.File]::ReadAllBytes($HelperPath)
  [void](Assert-FirstLaunchNoReparsePath $HelperPath 'Pinned private Windows Job helper after read')
  if ((Get-FirstLaunchSha256Bytes $helperBytes) -cne $script:FirstLaunchNativeJobHelperSha256) {
    throw 'The private Windows Job helper differs from its immutable source pin.'
  }
  try { $helperText = [Text.UTF8Encoding]::new($false, $true).GetString($helperBytes) }
  catch { throw 'The pinned private Windows Job helper is not strict UTF-8.' }
  try { return [scriptblock]::Create($helperText) }
  catch { throw 'The pinned private Windows Job helper could not be parsed from its verified bytes.' }
}

function Import-FirstLaunchVerifiedNativeJobHelperModule {
  param([Parameter(Mandatory = $true)][string] $HelperPath)
  $verifiedSource = Get-FirstLaunchVerifiedNativeJobHelperScriptBlock $HelperPath
  $module = New-Module -Name MorrowFirstLaunchNativeJob -ArgumentList $verifiedSource -ScriptBlock {
    param([scriptblock] $VerifiedSource)
    . $VerifiedSource
    Export-ModuleMember -Function CreateAtomicSuspendedRoot
  }
  Import-Module -ModuleInfo $module -Force -ErrorAction Stop
  $loaded = Get-Module -Name MorrowFirstLaunchNativeJob
  if ($null -eq $loaded -or -not $loaded.ExportedFunctions.ContainsKey('CreateAtomicSuspendedRoot')) {
    throw 'The pinned private Windows Job helper did not export its exact session factory.'
  }
  return $loaded
}

function Get-FirstLaunchNativeJobSession {
  param([Parameter(Mandatory = $true)][object] $Launch)
  if ([IO.Path]::DirectorySeparatorChar -ne '\') { throw 'The private Windows process Job is available only on Windows.' }
  if ($null -eq $script:FirstLaunchNativeJobModule) {
    $helperPath = Join-Path $PSScriptRoot 'windows-native-job.ps1'
    $script:FirstLaunchNativeJobModule = Import-FirstLaunchVerifiedNativeJobHelperModule $helperPath
  }
  $nativeSession = & $script:FirstLaunchNativeJobModule {
    param($ProcessLaunch)
    CreateAtomicSuspendedRoot -ExecutablePath ([string]$ProcessLaunch.executable) `
      -ArgumentList ([string[]]$ProcessLaunch.arguments) -Environment $ProcessLaunch.environment `
      -WorkingDirectory ([string]$ProcessLaunch.workingDirectory)
  } $Launch
  if ($null -eq $nativeSession) { throw 'The native Windows Job helper returned no private process session.' }
  return $nativeSession
}

function Invoke-FirstLaunchJobBoundedProcess {
  param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string[]] $Arguments,
    [Parameter(Mandatory = $true)][string] $WorkingDirectory,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary] $Environment,
    [Parameter(Mandatory = $true)][int] $TimeoutMs,
    [Parameter(Mandatory = $true)][int] $MaximumOutputBytes,
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [Parameter(Mandatory = $true)][string] $StageOwnerToken,
    [Parameter(Mandatory = $true)][ValidateSet('cargo', 'edge-version')][string] $ProcessRole,
    [string] $ExpectedExecutableSha256 = '',
    [scriptblock] $JobSessionFactory
  )
  [void](Assert-FirstLaunchStageClaim $StageRoot $StageOwnerToken)
  $workingDirectory = Assert-FirstLaunchPathBelowRoot $WorkingDirectory $StageRoot 'Private process working directory'
  if (-not [IO.Directory]::Exists($workingDirectory)) { throw 'The private process working directory does not exist.' }
  $requestId = [guid]::NewGuid().ToString('N').ToLowerInvariant()
  $requestBase = Join-Path $workingDirectory ('morrow-e003-g23-process-' + $requestId)
  $requestPath = $requestBase + '.request.json'
  $resultPath = $requestBase + '.result.json'
  $request = [ordered]@{
    schema = 'morrow.e003.g23.process-request.v1'
    requestId = $requestId
    stageRoot = [IO.Path]::GetFullPath($StageRoot)
    stageOwnerToken = $StageOwnerToken
    role = $ProcessRole
    executable = [IO.Path]::GetFullPath($Executable)
    arguments = @($Arguments)
    workingDirectory = $workingDirectory
    environment = [ordered]@{}
    timeoutMs = $TimeoutMs
    maximumOutputBytes = $MaximumOutputBytes
    runnerToolCache = [string]$env:RUNNER_TOOL_CACHE
    expectedExecutableSha256 = $ExpectedExecutableSha256
    resultPath = $resultPath
  }
  foreach ($key in $Environment.Keys) { $request.environment[[string]$key] = [string]$Environment[$key] }
  $requestBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $request -Depth 8 -Compress))
  if ($requestBytes.LongLength -le 0 -or $requestBytes.LongLength -gt 256KB) { throw 'The private process request exceeds its fixed size bound.' }
  [void](Assert-FirstLaunchNoReparsePath $requestPath 'Private process request destination')
  [void](Assert-FirstLaunchNoReparsePath $resultPath 'Private process result destination')
  Write-FirstLaunchNewFile $requestPath $requestBytes
  $requestSha256 = Get-Sha256 $requestPath
  $shimPath = Join-Path $PSScriptRoot 'windows-first-launch-preflight.ps1'
  [void](Assert-FirstLaunchNoReparsePath $shimPath 'Private PowerShell process shim')
  if (-not [IO.File]::Exists($shimPath)) { throw 'The private PowerShell process shim is missing.' }
  $shimSha256 = Get-Sha256 $shimPath
  if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    $pwshPath = Join-Path $PSHOME 'pwsh.exe'
  } elseif ($null -ne $JobSessionFactory) {
    $pwshPath = Join-Path $PSHOME 'pwsh'
  } else {
    throw 'The native private process Job cannot be started outside Windows.'
  }
  [void](Assert-FirstLaunchNoReparsePath $pwshPath 'Private PowerShell executable')
  if (-not [IO.File]::Exists($pwshPath)) { throw 'The private PowerShell executable is missing.' }
  $systemRoot = [string]$env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($systemRoot) -and $null -ne $JobSessionFactory) { $systemRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($StageRoot)) }
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or
      ([IO.Path]::DirectorySeparatorChar -eq '\' -and -not [IO.Directory]::Exists($systemRoot))) {
    throw 'SystemRoot is required for the private Windows process Job.'
  }
  $shimEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $shimEnvironment['SystemRoot'] = $systemRoot
  $shimEnvironment['WINDIR'] = $systemRoot
  $shimEnvironment['PATH'] = [string]::Join(';', @((Join-Path $systemRoot 'System32'), $systemRoot))
  $shimEnvironment['TEMP'] = [IO.Path]::GetFullPath($StageRoot)
  $shimEnvironment['TMP'] = [IO.Path]::GetFullPath($StageRoot)
  if (-not [string]::IsNullOrWhiteSpace([string]$env:RUNNER_TOOL_CACHE)) {
    $shimEnvironment['RUNNER_TOOL_CACHE'] = [string]$env:RUNNER_TOOL_CACHE
  }
  $launch = [pscustomobject]@{
    executable = $pwshPath
    arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $shimPath, '-ProcessShim',
      '-ProcessRequestPath', $requestPath, '-ProcessRequestSha256', $requestSha256,
      '-ProcessShimScriptSha256', $shimSha256)
    environment = $shimEnvironment
    workingDirectory = [IO.Path]::GetFullPath($StageRoot)
    requestPath = $requestPath
    resultPath = $resultPath
    requestSha256 = $requestSha256
    shimSha256 = $shimSha256
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $deadlineMs = [long]$TimeoutMs
  $session = $null
  $stageJobDrained = $false
  $validReceipt = $false
  try {
    if ($null -ne $JobSessionFactory) { $session = & $JobSessionFactory $launch }
    else { $session = Get-FirstLaunchNativeJobSession $launch }
    if ($null -eq $session) { throw 'The private process Job factory returned no session.' }
    if ($clock.ElapsedMilliseconds -ge $deadlineMs) {
      $stop = $session.StopAndWait(300)
      if (-not $stop.jobEmpty -or -not $stop.rootExited) { throw 'The private process Job did not stop before resume within its bounded cleanup window.' }
      throw 'The private PowerShell process Job exceeded its monotonic command deadline before resume.'
    }
    [void]$session.Resume()
    while ($true) {
      if ($clock.ElapsedMilliseconds -ge $deadlineMs) {
        $stop = $session.StopAndWait(300)
        if (-not $stop.jobEmpty -or -not $stop.rootExited) { throw 'The private process Job did not stop within its bounded cleanup window.' }
        throw 'The private PowerShell process Job exceeded the monotonic command deadline.'
      }
      $observation = $session.ObserveRoot()
      $members = @($session.ListMemberIds())
      if ($clock.ElapsedMilliseconds -ge $deadlineMs) {
        $stop = $session.StopAndWait(300)
        if (-not $stop.jobEmpty -or -not $stop.rootExited) { throw 'The expired private process Job did not stop within its bounded cleanup window.' }
        throw 'The private PowerShell process Job exceeded the monotonic command deadline.'
      }
      if ($members.Count -gt 256) {
        $stop = $session.StopAndWait(300)
        if (-not $stop.jobEmpty -or -not $stop.rootExited) { throw 'The oversized private process Job did not stop within its bounded cleanup window.' }
        throw 'The private process Job exceeded its member observation bound.'
      }
      if ([string]$observation.state -ceq 'exited') {
        if ($members.Count -gt 0) {
          $stop = $session.StopAndWait(300)
          if (-not $stop.jobEmpty -or -not $stop.rootExited) { throw 'The private process Job left members after bounded tree termination.' }
          throw 'The private PowerShell process exited while owned descendants remained in its Job.'
        }
        if ($null -eq $observation.exitCode -or [int]$observation.exitCode -ne 0) {
          throw 'The private PowerShell process shim exited unsuccessfully.'
        }
        $stageJobDrained = $true
        break
      }
      $remainingMs = [int][Math]::Max(1, [Math]::Min(25, $deadlineMs - $clock.ElapsedMilliseconds))
      Start-Sleep -Milliseconds $remainingMs
    }
    [void](Assert-FirstLaunchStageClaim $StageRoot $StageOwnerToken)
    [void](Assert-FirstLaunchNoReparsePath $requestPath 'Private process request after completion')
    [void](Assert-FirstLaunchNoReparsePath $resultPath 'Private process result after completion')
    if (-not [IO.File]::Exists($resultPath)) { throw 'The private PowerShell process shim produced no result receipt.' }
    $resultInfo = Get-Item -LiteralPath $resultPath
    $resultMaximum = [long]$MaximumOutputBytes * 8 + 64KB
    if ($resultInfo.Length -le 0 -or $resultInfo.Length -gt $resultMaximum) {
      throw 'The private PowerShell process receipt exceeds its strict serialized byte bound.'
    }
    $receiptBytes = [IO.File]::ReadAllBytes($resultPath)
    try {
      $receipt = ConvertFrom-Json -InputObject ([Text.UTF8Encoding]::new($false, $true).GetString($receiptBytes)) `
        -AsHashtable -NoEnumerate -DateKind String -ErrorAction Stop
    } catch { throw 'The private PowerShell process receipt is malformed JSON.' }
    $receiptKeys = @('exitCode', 'outputLimitExceeded', 'requestId', 'schema', 'stageOwnerToken', 'stderr', 'stdout', 'timedOut')
    if ($receipt -isnot [Collections.IDictionary] -or $receipt.Keys.Count -ne $receiptKeys.Count -or
        @($receipt.Keys | Where-Object { [string]$_ -cnotin $receiptKeys }).Count -gt 0 -or
        [string]$receipt.schema -cne 'morrow.e003.g23.process-result.v1' -or
        [string]$receipt.requestId -cne $requestId -or [string]$receipt.stageOwnerToken -cne $StageOwnerToken -or
        ($receipt.exitCode -isnot [int] -and $receipt.exitCode -isnot [long]) -or
        $receipt.outputLimitExceeded -isnot [bool] -or $receipt.timedOut -isnot [bool] -or
        $receipt.stdout -isnot [string] -or $receipt.stderr -isnot [string] -or
        [Text.Encoding]::UTF8.GetByteCount([string]$receipt.stdout) + [Text.Encoding]::UTF8.GetByteCount([string]$receipt.stderr) -gt $MaximumOutputBytes) {
      throw 'The private PowerShell process receipt does not match its exact request or output bound.'
    }
    $validReceipt = $true
    return [pscustomobject]@{
      ExitCode = [int]$receipt.exitCode
      StandardOutput = [string]$receipt.stdout
      StandardError = [string]$receipt.stderr
      TimedOut = [bool]$receipt.timedOut
      OutputLimitExceeded = [bool]$receipt.outputLimitExceeded
    }
  } finally {
    if ($null -ne $session) { try { $session.Dispose() } catch { } }
    if ($stageJobDrained -and $validReceipt) {
      try {
        [void](Assert-FirstLaunchStageClaim $StageRoot $StageOwnerToken)
        [void](Assert-FirstLaunchNoReparsePath $requestPath 'Completed process request cleanup')
        if ([IO.File]::Exists($requestPath) -and (Get-Sha256 $requestPath) -ceq $requestSha256) { [IO.File]::Delete($requestPath) }
        [void](Assert-FirstLaunchNoReparsePath $resultPath 'Completed process receipt cleanup')
        if ([IO.File]::Exists($resultPath)) { [IO.File]::Delete($resultPath) }
      } catch { }
    }
  }
}

function Assert-FirstLaunchScopedCargoPath {
  param([Parameter(Mandatory = $true)][string] $CargoPath)
  $toolCache = [string]$env:RUNNER_TOOL_CACHE
  if ([string]::IsNullOrWhiteSpace($toolCache) -or -not [IO.Path]::IsPathRooted($toolCache) -or
      -not [IO.Path]::IsPathRooted($CargoPath)) {
    throw 'Cargo and RUNNER_TOOL_CACHE must be absolute paths supplied by the trusted runner.'
  }
  $cacheFull = [IO.Path]::GetFullPath($toolCache).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $cargoFull = [IO.Path]::GetFullPath($CargoPath)
  if (-not [IO.Directory]::Exists($cacheFull) -or
      -not [string]::Equals($toolCache.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), $cacheFull, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($CargoPath, $cargoFull, [StringComparison]::OrdinalIgnoreCase) -or
      -not $cargoFull.StartsWith($cacheFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($cargoFull) -cne 'cargo.exe' -or -not [IO.File]::Exists($cargoFull)) {
    throw 'Cargo must be an existing canonical cargo.exe below RUNNER_TOOL_CACHE.'
  }
  [void](Assert-FirstLaunchNoReparsePath $cargoFull 'Scoped Cargo executable')
  return $cargoFull
}

function Assert-FirstLaunchNoCargoAncestorConfig {
  param([Parameter(Mandatory = $true)][string] $WorkingDirectory, [Parameter(Mandatory = $true)][string] $CargoHome)
  $current = [IO.Path]::GetFullPath($WorkingDirectory)
  $root = [IO.Path]::GetPathRoot($current)
  while ($true) {
    foreach ($fileName in @('config', 'config.toml')) {
      $configPath = Join-Path (Join-Path $current '.cargo') $fileName
      if ([IO.File]::Exists($configPath) -or [IO.Directory]::Exists($configPath)) {
        throw 'A Cargo config exists in the isolated working-directory ancestry.'
      }
    }
    if ([string]::Equals($current.TrimEnd('\', '/'), $root.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { break }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or [string]::Equals($parent, $current, [StringComparison]::OrdinalIgnoreCase)) { break }
    $current = $parent
  }
  foreach ($fileName in @('config', 'config.toml')) {
    $cargoConfig = Join-Path $CargoHome $fileName
    if ([IO.File]::Exists($cargoConfig) -or [IO.Directory]::Exists($cargoConfig)) {
      throw 'The private Cargo home unexpectedly contains a source configuration.'
    }
  }
}

function New-FirstLaunchCargoEnvironment {
  param(
    [Parameter(Mandatory = $true)][string] $CargoPath,
    [Parameter(Mandatory = $true)][string] $CargoHome,
    [Parameter(Mandatory = $true)][string] $WorkingDirectory,
    [Parameter(Mandatory = $true)][string] $TargetDirectory
  )
  $cargoFull = Assert-FirstLaunchScopedCargoPath $CargoPath
  Assert-FirstLaunchNoCargoAncestorConfig $WorkingDirectory $CargoHome
  $toolCache = [IO.Path]::GetFullPath([string]$env:RUNNER_TOOL_CACHE)
  $rustupHome = [string]$env:RUSTUP_HOME
  if (-not [string]::IsNullOrWhiteSpace($rustupHome)) {
    if (-not [IO.Path]::IsPathRooted($rustupHome)) { throw 'RUSTUP_HOME must be an absolute path.' }
    $rustupFull = [IO.Path]::GetFullPath($rustupHome)
    if (-not $rustupFull.StartsWith($toolCache.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Directory]::Exists($rustupFull)) {
      throw 'RUSTUP_HOME must be an existing runner-tool-cache directory.'
    }
    [void](Assert-FirstLaunchNoReparsePath $rustupFull 'Scoped RUSTUP_HOME')
    $rustupHome = $rustupFull
  }
  $systemRoot = [string]$env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or -not [IO.Directory]::Exists($systemRoot)) {
    throw 'SystemRoot is required for a scoped Windows Cargo invocation.'
  }
  $cargoDirectory = [IO.Path]::GetDirectoryName($cargoFull)
  $pathEntries = [Collections.Generic.List[string]]::new()
  $pathEntries.Add($cargoDirectory)
  foreach ($candidate in @((Join-Path $systemRoot 'System32'), $systemRoot)) {
    if ([IO.Directory]::Exists($candidate) -and -not $pathEntries.Contains($candidate)) { $pathEntries.Add($candidate) }
  }
  $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $environment['PATH'] = [string]::Join(';', $pathEntries.ToArray())
  $environment['SystemRoot'] = $systemRoot
  $environment['WINDIR'] = $systemRoot
  $environment['TEMP'] = $WorkingDirectory
  $environment['TMP'] = $WorkingDirectory
  $environment['HOME'] = $CargoHome
  $environment['USERPROFILE'] = $CargoHome
  $environment['CARGO_HOME'] = $CargoHome
  $environment['CARGO_TARGET_DIR'] = $TargetDirectory
  $environment['CARGO_NET_GIT_FETCH_WITH_CLI'] = 'false'
  $environment['CARGO_REGISTRIES_CRATES_IO_PROTOCOL'] = 'sparse'
  $environment['GIT_CONFIG_NOSYSTEM'] = '1'
  $environment['GIT_TERMINAL_PROMPT'] = '0'
  if (-not [string]::IsNullOrWhiteSpace($rustupHome)) { $environment['RUSTUP_HOME'] = $rustupHome }
  return [pscustomobject]@{ Executable = $cargoFull; Environment = $environment }
}

function ConvertFrom-FirstLaunchCargoVersion {
  param([Parameter(Mandatory = $true)][string] $Output)
  $matches = [regex]::Matches($Output.Trim(), '(?m)^cargo (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b')
  if ($matches.Count -ne 1) { throw 'The scoped Cargo --version output is malformed or ambiguous.' }
  return 'cargo ' + $matches[0].Groups[1].Value
}

function Assert-FirstLaunchCargoInstallList {
  param([Parameter(Mandatory = $true)][string] $Output)
  $lines = @($Output -split "`r?`n" | Where-Object { $_ -match '^\S' })
  $matches = @($lines | Where-Object { $_ -match '^tauri-driver v2\.1\.0:$' })
  if ($matches.Count -ne 1 -or $lines.Count -ne 1) {
    throw 'Cargo install --list did not identify exactly the pinned tauri-driver 2.1.0 package.'
  }
  return '2.1.0'
}

function Get-FirstLaunchTauriDriver {
  param(
    [Parameter(Mandatory = $true)][string] $CargoPath,
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [scriptblock] $ProcessRunner,
    [string] $StageOwnerToken
  )
  $toolRoot = Join-Path $StageRoot 'tauri-tool-stage'
  $cargoHome = Join-Path $StageRoot 'cargo-home'
  $workingDirectory = Join-Path $StageRoot 'cargo-work'
  $targetDirectory = Join-Path $StageRoot 'cargo-target'
  foreach ($path in @($toolRoot, $cargoHome, $workingDirectory, $targetDirectory)) {
    [void](Assert-FirstLaunchNewDirectoryPath $path 'Private Cargo stage directory')
    [void][IO.Directory]::CreateDirectory($path)
    [void](Assert-FirstLaunchNoReparsePath $path 'Private Cargo stage directory')
  }
  $scope = New-FirstLaunchCargoEnvironment $CargoPath $cargoHome $workingDirectory $targetDirectory
  $versionResult = Invoke-FirstLaunchBoundedProcess $scope.Executable @('--version') $workingDirectory `
    $scope.Environment 30000 4096 -ProcessRunner $ProcessRunner -StageRoot $StageRoot `
    -StageOwnerToken $StageOwnerToken -ProcessRole cargo
  if ($versionResult.ExitCode -ne 0) { throw 'The scoped Cargo --version command failed.' }
  $cargoVersion = ConvertFrom-FirstLaunchCargoVersion ([string]$versionResult.StdOut)

  $installArgs = @('install', 'tauri-driver', '--version', $script:FirstLaunchTauriDriverVersion, '--locked', '--root', $toolRoot)
  $install = Invoke-FirstLaunchBoundedProcess $scope.Executable $installArgs $workingDirectory `
    $scope.Environment $script:FirstLaunchCargoTimeoutMs $script:FirstLaunchCargoOutputBytes -ProcessRunner $ProcessRunner `
    -StageRoot $StageRoot -StageOwnerToken $StageOwnerToken -ProcessRole cargo
  if ($install.ExitCode -ne 0) { throw 'The pinned tauri-driver 2.1.0 Cargo install failed.' }
  $listResult = Invoke-FirstLaunchBoundedProcess $scope.Executable @('install', '--list', '--root', $toolRoot) `
    $workingDirectory $scope.Environment 30000 16384 -ProcessRunner $ProcessRunner -StageRoot $StageRoot `
    -StageOwnerToken $StageOwnerToken -ProcessRole cargo
  if ($listResult.ExitCode -ne 0) { throw 'The scoped Cargo install --list command failed.' }
  $version = Assert-FirstLaunchCargoInstallList ([string]$listResult.StdOut + [Environment]::NewLine + [string]$listResult.StdErr)
  if ($version -cne $script:FirstLaunchTauriDriverVersion) { throw 'Cargo installed a tauri-driver version different from its exact pin.' }

  $driverPath = Join-Path (Join-Path $toolRoot 'bin') 'tauri-driver.exe'
  [void](Assert-FirstLaunchNoReparsePath $toolRoot 'Tauri driver tool root')
  [void](Assert-FirstLaunchNoReparsePath $driverPath 'Tauri driver executable')
  if (-not [IO.File]::Exists($driverPath)) { throw 'The pinned tauri-driver installation produced no tauri-driver.exe.' }
  $attributes = [IO.File]::GetAttributes($driverPath)
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
      ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-Item -LiteralPath $driverPath).Length -le 0) {
    throw 'The installed tauri-driver is not a plain non-empty executable file.'
  }
  return [ordered]@{
    version = $version
    source = 'crates.io'
    sourceUrl = $script:FirstLaunchTauriSourceUrl
    downloadUrl = $script:FirstLaunchTauriDownloadUrl
    cargoVersion = $cargoVersion
    installCommand = 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>'
    executableSha256 = Get-Sha256 $driverPath
    serviceStarted = $false
  }
}

function Get-FirstLaunchEdgeDriver {
  param(
    [Parameter(Mandatory = $true)][string] $RuntimeVersion,
    [Parameter(Mandatory = $true)][string] $StageRoot,
    [scriptblock] $Transport,
    [scriptblock] $ProcessRunner,
    [string] $StageOwnerToken
  )
  $edgeRoot = Join-Path $StageRoot 'edge-driver-stage'
  [void](Assert-FirstLaunchNewDirectoryPath $edgeRoot 'EdgeDriver stage directory')
  [void][IO.Directory]::CreateDirectory($edgeRoot)
  [void](Assert-FirstLaunchNoReparsePath $edgeRoot 'EdgeDriver stage directory')
  $catalogUri = [uri]$script:FirstLaunchEdgeCatalogUrl
  $catalogResponse = Invoke-FirstLaunchHttpGet $catalogUri @{} 30000 $script:FirstLaunchMaxEdgeCatalogBytes -Transport $Transport
  if ($catalogResponse.statusCode -ne 200) { throw 'The official EdgeDriver catalog request did not return HTTP 200; redirects are rejected.' }
  $catalogContentType = Get-FirstLaunchHeaderValue $catalogResponse.headers 'Content-Type'
  if ($catalogContentType -cne 'application/json') { throw 'The official EdgeDriver catalog Content-Type is not application/json.' }
  $catalogBytes = [byte[]]$catalogResponse.bodyBytes
  $release = ConvertFrom-FirstLaunchEdgeCatalog $catalogBytes $RuntimeVersion

  $archivePath = Join-Path $edgeRoot 'edgedriver.zip'
  $downloadUrl = $script:FirstLaunchEdgeRootUrl + '/' + $release.version + '/edgedriver_win64.zip'
  if ($release.downloadUrl -cne $downloadUrl -or $release.sourceCatalogUrl -cne $script:FirstLaunchEdgeCatalogUrl -or
      $release.sourcePageUrl -cne $script:FirstLaunchEdgeSourcePageUrl) {
    throw 'The selected EdgeDriver provenance does not match the fixed Microsoft HTTPS source.'
  }
  $downloadUri = [uri]$downloadUrl
  if ($downloadUri.Scheme -cne 'https' -or $downloadUri.Host -cne 'msedgedriver.microsoft.com' -or
      -not $downloadUri.IsDefaultPort -or -not [string]::IsNullOrEmpty($downloadUri.UserInfo) -or
      -not [string]::IsNullOrEmpty($downloadUri.Query) -or -not [string]::IsNullOrEmpty($downloadUri.Fragment)) {
    throw 'The selected EdgeDriver download URL is outside the fixed official HTTPS origin.'
  }
  $downloadResponse = Invoke-FirstLaunchHttpGet $downloadUri @{} 120000 ([long]$release.expectedArchiveBytes) `
    $archivePath -Transport $Transport
  if ($downloadResponse.statusCode -ne 200 -or -not $downloadResponse.bodyPathCreated) {
    throw 'The official EdgeDriver archive request failed or redirected; redirects are rejected.'
  }
  $archiveContentType = Get-FirstLaunchHeaderValue $downloadResponse.headers 'Content-Type'
  if ($archiveContentType -cnotin @('application/x-zip-compressed', 'application/zip', 'application/octet-stream')) {
    throw 'The official EdgeDriver archive has an unexpected Content-Type.'
  }
  if ([long]$downloadResponse.bodyLength -ne [long]$release.expectedArchiveBytes -or
      -not [IO.File]::Exists($archivePath)) {
    throw 'The EdgeDriver ZIP byte length differs from the selected catalog item.'
  }
  [void](Assert-FirstLaunchNoReparsePath $archivePath 'EdgeDriver archive')
  $archiveInfo = Assert-FirstLaunchZipPolicy $archivePath 0 -1
  $zipStream = [IO.File]::OpenRead($archivePath)
  $zipArchive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    $exeEntries = @($zipArchive.Entries | Where-Object { [IO.Path]::GetExtension([string]$_.FullName) -ieq '.exe' })
    if ($exeEntries.Count -ne 1 -or [string]$exeEntries[0].FullName -cne 'msedgedriver.exe') {
      throw 'The official EdgeDriver ZIP must contain exactly one root msedgedriver.exe and no other executable.'
    }
  } finally { $zipArchive.Dispose() }

  $extractRoot = Join-Path $edgeRoot 'contents'
  [void](Expand-FirstLaunchSafeZipArchive $archivePath $extractRoot $archiveInfo.EntryCount $archiveInfo.TotalUncompressedBytes)
  [void](Assert-FirstLaunchNoReparsePath $extractRoot 'EdgeDriver extraction root')
  $driverPath = Join-Path $extractRoot 'msedgedriver.exe'
  [void](Assert-FirstLaunchNoReparsePath $driverPath 'EdgeDriver executable')
  if (-not [IO.File]::Exists($driverPath)) { throw 'The official EdgeDriver ZIP did not extract its root executable.' }
  $driverAttributes = [IO.File]::GetAttributes($driverPath)
  $driverSize = [long](Get-Item -LiteralPath $driverPath).Length
  if (($driverAttributes -band [IO.FileAttributes]::Directory) -ne 0 -or
      ($driverAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $driverSize -le 0) {
    throw 'The extracted EdgeDriver is not a plain non-empty executable file.'
  }
  [void](Assert-FirstLaunchPeX64 -ExecutablePath $driverPath -Label 'Extracted EdgeDriver')
  $archiveSize = [long](Get-Item -LiteralPath $archivePath).Length
  $archiveSha256 = Get-Sha256 $archivePath
  $driverSha256 = Get-Sha256 $driverPath
  $driverEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $systemRoot = [string]$env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($systemRoot) -or -not [IO.Directory]::Exists($systemRoot)) {
    throw 'SystemRoot is required for the bounded EdgeDriver version probe.'
  }
  $driverEnvironment['SystemRoot'] = $systemRoot
  $driverEnvironment['WINDIR'] = $systemRoot
  $driverEnvironment['TEMP'] = $edgeRoot
  $driverEnvironment['TMP'] = $edgeRoot
  $driverEnvironment['MSEDGEDRIVER_TELEMETRY_OPTOUT'] = '1'
  $driverEnvironment['PATH'] = [string]::Join(';', @((Join-Path $systemRoot 'System32'), $systemRoot))
  # Recheck both measured files and all selection pins immediately before the sole driver probe.
  if ([long](Get-Item -LiteralPath $archivePath).Length -ne [long]$release.expectedArchiveBytes -or
      (Get-Sha256 $archivePath) -cne $archiveSha256 -or
      (Get-Item -LiteralPath $driverPath).Length -ne $driverSize -or
      (Get-Sha256 $driverPath) -cne $driverSha256 -or
      $release.runtimeVersion -cne $RuntimeVersion -or
      $release.compatibleFirstThreeComponents -cne (($RuntimeVersion -split '\.')[0..2] -join '.') -or
      $release.downloadUrl -cne $downloadUrl) {
    throw 'The selected EdgeDriver files or provenance changed before the version probe.'
  }
  $probe = Invoke-FirstLaunchBoundedProcess $driverPath @('--version') $edgeRoot $driverEnvironment `
    $script:FirstLaunchEdgeProbeTimeoutMs $script:FirstLaunchEdgeProbeOutputBytes -ProcessRunner $ProcessRunner `
    -StageRoot $StageRoot -StageOwnerToken $StageOwnerToken -ProcessRole edge-version `
    -ExpectedExecutableSha256 $driverSha256
  if ([bool]$probe.TimedOut -or [bool]$probe.OutputLimitExceeded) {
    throw 'The bounded EdgeDriver version probe timed out or exceeded its output limit.'
  }
  if ([int]$probe.ExitCode -ne 0) { throw 'The bounded EdgeDriver version probe failed.' }
  $versionMatch = [regex]::Match([string]$probe.StdOut, '\AMSEdgeDriver (?<version>\d+\.\d+\.\d+\.\d+)(?: [^\r\n]*)?\r?\n?\z')
  if (-not $versionMatch.Success -or $versionMatch.Groups['version'].Value -cne [string]$release.version) {
    throw 'The EdgeDriver --version output differs from the selected official catalog version.'
  }
  return [ordered]@{
    version = [string]$release.version
    runtimeVersion = [string]$release.runtimeVersion
    compatibleFirstThreeComponents = [string]$release.compatibleFirstThreeComponents
    sourcePageUrl = [string]$release.sourcePageUrl
    sourceCatalogUrl = [string]$release.sourceCatalogUrl
    downloadUrl = [string]$release.downloadUrl
    responseUrl = [string]$release.downloadUrl
    catalogGeneratedAtUtc = [string]$release.catalogGeneratedAtUtc
    catalogSizeBytes = [long]$release.catalogSizeBytes
    catalogItemCount = [int]$release.catalogItemCount
    catalogSha256 = [string]$release.catalogSha256
    selectedLastModified = [string]$release.selectedLastModified
    expectedArchiveBytes = [long]$release.expectedArchiveBytes
    archiveSizeBytes = $archiveSize
    archiveSha256 = $archiveSha256
    executableSha256 = $driverSha256
    versionProbeExitCode = [int]$probe.ExitCode
    serviceStarted = $false
  }
}

function Assert-FirstLaunchWebView2Dto {
  param([Parameter(Mandatory = $true)][object] $Runtime)
  if ([string]$Runtime.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'The WebView2 runtime version is malformed.' }
  $timestamp = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact(
      [string]$Runtime.observedAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture,
      ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$timestamp
    )) { throw 'The WebView2 observation time is not canonical UTC milliseconds.' }
  $allowedSources = @(
    ('HKLM64\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + $script:FirstLaunchWebView2Guid),
    ('HKCU64\Software\Microsoft\EdgeUpdate\Clients\' + $script:FirstLaunchWebView2Guid)
  )
  if ($Runtime.sources.Count -lt 1 -or $Runtime.sources.Count -gt 2) { throw 'The WebView2 observation has an invalid registry source count.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($source in $Runtime.sources) {
    if ($source.registryPath -cnotin $allowedSources -or $source.version -cne [string]$Runtime.version -or
        -not $seen.Add([string]$source.registryPath)) {
      throw 'The WebView2 registry observations are unapproved, duplicated, or divergent.'
    }
  }
  return $Runtime
}

function New-FirstLaunchStageDto {
  param(
    [Parameter(Mandatory = $true)][object] $Identity,
    [Parameter(Mandatory = $true)][object] $PackageResult,
    [Parameter(Mandatory = $true)][object] $Runtime,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary] $TauriDriver,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary] $EdgeDriver,
    [string] $StagedAtUtc = (Get-FirstLaunchUtcMilliseconds)
  )
  $gateKeys = @('repository', 'ref', 'workflowPath', 'workflowRef', 'sourceSha', 'gateRunId', 'gateRunAttempt', 'event')
  $runnerKeys = @('os', 'arch', 'tempRoot', 'workspace')
  if ($Identity.gate.Keys.Count -ne $gateKeys.Count -or @($Identity.gate.Keys | Where-Object { $_ -cnotin $gateKeys }).Count -gt 0 -or
      $Identity.runner.Keys.Count -ne $runnerKeys.Count -or @($Identity.runner.Keys | Where-Object { $_ -cnotin $runnerKeys }).Count -gt 0) {
    throw 'The Stage run identity has unexpected or missing gate or runner fields.'
  }
  if ([string]$Identity.gate.repository -cne $script:FirstLaunchGateRepository -or
      [string]$Identity.gate.ref -cne $script:FirstLaunchGateRef -or
      [string]$Identity.gate.workflowPath -cne $script:FirstLaunchWorkflowPath -or
      [string]$Identity.gate.workflowRef -cne $script:FirstLaunchWorkflowRef -or
      [string]$Identity.gate.event -cne $script:FirstLaunchGateEvent -or
      [string]$Identity.gate.sourceSha -notmatch '^[0-9a-f]{40}$' -or
      [string]$Identity.gate.gateRunId -notmatch '^[1-9][0-9]{0,19}$' -or
      [string]$Identity.gate.gateRunId -ceq [string]$script:FirstLaunchCandidate.buildRunId -or
      [string]$Identity.gate.gateRunAttempt -cne '1') {
    throw 'The Stage gate identity is invalid or aliases the candidate build run.'
  }
  if ([string]$Identity.runner.os -cne 'Windows' -or [string]$Identity.runner.arch -cne 'X64') {
    throw 'The Stage runner must be Windows X64.'
  }
  $tempRoot = Assert-FirstLaunchCanonicalWindowsPath ([string]$Identity.runner.tempRoot) 'RUNNER_TEMP'
  $workspace = Assert-FirstLaunchCanonicalWindowsPath ([string]$Identity.runner.workspace) 'GITHUB_WORKSPACE'
  if (Test-FirstLaunchWindowsPathsOverlap $tempRoot $workspace) {
    throw 'RUNNER_TEMP must be isolated from GITHUB_WORKSPACE.'
  }
  if ($PackageResult.receipt.schema -cne 'morrow.e003.g23.verified-package.v1' -or
      $PackageResult.receipt.status -cne 'verified' -or
      [string]$PackageResult.receipt.candidateBuildRunId -cne [string]$script:FirstLaunchCandidate.buildRunId -or
      [string]$PackageResult.receipt.candidateBuildRunAttempt -cne [string]$script:FirstLaunchCandidate.buildRunAttempt -or
      [string]$PackageResult.receipt.artifact.id -cne [string]$script:FirstLaunchCandidate.artifact.id) {
    throw 'The verified package receipt is not bound to the fixed 2.2 candidate build.'
  }
  $expectedInventory = Get-FirstLaunchInventory
  if (-not (Test-FirstLaunchSameJsonValue $PackageResult.receipt.packageInventory $expectedInventory) -or
      [string]$PackageResult.receipt.packageInventorySha256 -cne [string]$script:FirstLaunchCandidate.package.canonicalInventorySha256) {
    throw 'The verified package inventory differs from the fixed 19-file candidate invoice.'
  }
  $runtime = Assert-FirstLaunchWebView2Dto $Runtime
  $tauriKeys = @('version', 'source', 'sourceUrl', 'downloadUrl', 'cargoVersion', 'installCommand', 'executableSha256', 'serviceStarted')
  if ($TauriDriver.Keys.Count -ne $tauriKeys.Count -or @($TauriDriver.Keys | Where-Object { $_ -cnotin $tauriKeys }).Count -gt 0 -or
      [string]$TauriDriver.version -cne $script:FirstLaunchTauriDriverVersion -or
      [string]$TauriDriver.source -cne 'crates.io' -or [string]$TauriDriver.sourceUrl -cne $script:FirstLaunchTauriSourceUrl -or
      [string]$TauriDriver.downloadUrl -cne $script:FirstLaunchTauriDownloadUrl -or
      [string]$TauriDriver.installCommand -cne 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>' -or
      [string]$TauriDriver.cargoVersion -notmatch '^cargo \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or
      [string]$TauriDriver.executableSha256 -notmatch '^[0-9a-f]{64}$' -or $TauriDriver.serviceStarted -ne $false) {
    throw 'Tauri driver provenance does not match the fixed source, version, command, or stopped-service policy.'
  }
  $edgeKeys = @('version', 'runtimeVersion', 'compatibleFirstThreeComponents', 'sourcePageUrl', 'sourceCatalogUrl',
    'downloadUrl', 'responseUrl', 'catalogGeneratedAtUtc', 'catalogSizeBytes', 'catalogItemCount', 'catalogSha256',
    'selectedLastModified', 'expectedArchiveBytes', 'archiveSizeBytes', 'archiveSha256', 'executableSha256',
    'versionProbeExitCode', 'serviceStarted')
  if ($EdgeDriver.Keys.Count -ne $edgeKeys.Count -or @($EdgeDriver.Keys | Where-Object { $_ -cnotin $edgeKeys }).Count -gt 0) {
    throw 'EdgeDriver provenance has unexpected or missing fields.'
  }
  $runtimePrefix = ([string]$runtime.version -split '\.')[0..2] -join '.'
  $edgeVersionPrefix = ([string]$EdgeDriver.version -split '\.')[0..2] -join '.'
  $catalogGenerated = ConvertTo-FirstLaunchPreciseCatalogUtc ([string]$EdgeDriver.catalogGeneratedAtUtc) 'EdgeDriver catalog generatedAt'
  $selectedModified = ConvertTo-FirstLaunchPreciseCatalogUtc ([string]$EdgeDriver.selectedLastModified) 'EdgeDriver selected lastModified'
  if ([string]$EdgeDriver.version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
      [string]$EdgeDriver.runtimeVersion -cne [string]$runtime.version -or $edgeVersionPrefix -cne $runtimePrefix -or
      [string]$EdgeDriver.compatibleFirstThreeComponents -cne $runtimePrefix -or
      [string]$EdgeDriver.sourcePageUrl -cne $script:FirstLaunchEdgeSourcePageUrl -or
      [string]$EdgeDriver.sourceCatalogUrl -cne $script:FirstLaunchEdgeCatalogUrl -or
      [string]$EdgeDriver.downloadUrl -cne ($script:FirstLaunchEdgeRootUrl + '/' + [string]$EdgeDriver.version + '/edgedriver_win64.zip') -or
      [string]$EdgeDriver.responseUrl -cne [string]$EdgeDriver.downloadUrl -or
      [string]$EdgeDriver.catalogSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$EdgeDriver.archiveSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$EdgeDriver.executableSha256 -notmatch '^[0-9a-f]{64}$' -or
      [int]$EdgeDriver.versionProbeExitCode -ne 0 -or $EdgeDriver.serviceStarted -ne $false -or
      [long]$EdgeDriver.expectedArchiveBytes -le 0 -or [long]$EdgeDriver.archiveSizeBytes -ne [long]$EdgeDriver.expectedArchiveBytes -or
      [long]$EdgeDriver.catalogSizeBytes -le 0 -or [int]$EdgeDriver.catalogItemCount -le 0) {
    throw 'EdgeDriver provenance does not match the official HTTPS catalog selection or file measurements.'
  }
  $staged = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact(
      $StagedAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture,
      ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$staged
    )) { throw 'Stage completion time must be canonical UTC milliseconds.' }
  $runtimeObserved = [DateTimeOffset]::ParseExact([string]$runtime.observedAtUtc, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
  if ($runtimeObserved -gt $staged) { throw 'The WebView2 observation postdates Stage completion.' }
  if ($catalogGenerated.Value -gt $staged -or $selectedModified.Value -gt $staged) {
    throw 'The EdgeDriver catalog provenance postdates Stage completion.'
  }
  return [ordered]@{
    schema = $script:FirstLaunchStageSchema
    status = 'staged'
    purpose = $script:FirstLaunchPurpose
    executionPhase = $script:FirstLaunchExecutionPhase
    gate = [ordered]@{
      repository = [string]$Identity.gate.repository
      ref = [string]$Identity.gate.ref
      workflowPath = [string]$Identity.gate.workflowPath
      workflowRef = [string]$Identity.gate.workflowRef
      sourceSha = [string]$Identity.gate.sourceSha
      gateRunId = [string]$Identity.gate.gateRunId
      gateRunAttempt = [string]$Identity.gate.gateRunAttempt
      event = [string]$Identity.gate.event
    }
    runner = [ordered]@{ os = 'Windows'; arch = 'X64'; tempRoot = $tempRoot }
    webView2Runtime = [ordered]@{
      version = [string]$runtime.version
      observedAtUtc = [string]$runtime.observedAtUtc
      sources = @($runtime.sources | ForEach-Object { [ordered]@{ registryPath = [string]$_.registryPath; version = [string]$_.version } })
    }
    candidateBuild = Get-FirstLaunchCandidateBuildDto
    packageInventory = @($PackageResult.receipt.packageInventory | ForEach-Object {
      [ordered]@{ path = [string]$_.path; sizeBytes = [long]$_.sizeBytes; sha256 = [string]$_.sha256 }
    })
    drivers = [ordered]@{
      tauriDriver = [ordered]@{
        version = [string]$TauriDriver.version
        source = [string]$TauriDriver.source
        sourceUrl = [string]$TauriDriver.sourceUrl
        downloadUrl = [string]$TauriDriver.downloadUrl
        cargoVersion = [string]$TauriDriver.cargoVersion
        installCommand = [string]$TauriDriver.installCommand
        executableSha256 = [string]$TauriDriver.executableSha256
        serviceStarted = $false
      }
      edgeDriver = [ordered]@{
        version = [string]$EdgeDriver.version
        runtimeVersion = [string]$EdgeDriver.runtimeVersion
        compatibleFirstThreeComponents = [string]$EdgeDriver.compatibleFirstThreeComponents
        sourcePageUrl = [string]$EdgeDriver.sourcePageUrl
        sourceCatalogUrl = [string]$EdgeDriver.sourceCatalogUrl
        downloadUrl = [string]$EdgeDriver.downloadUrl
        responseUrl = [string]$EdgeDriver.responseUrl
        catalogGeneratedAtUtc = [string]$EdgeDriver.catalogGeneratedAtUtc
        catalogSizeBytes = [long]$EdgeDriver.catalogSizeBytes
        catalogItemCount = [int]$EdgeDriver.catalogItemCount
        catalogSha256 = [string]$EdgeDriver.catalogSha256
        selectedLastModified = [string]$EdgeDriver.selectedLastModified
        expectedArchiveBytes = [long]$EdgeDriver.expectedArchiveBytes
        archiveSizeBytes = [long]$EdgeDriver.archiveSizeBytes
        archiveSha256 = [string]$EdgeDriver.archiveSha256
        executableSha256 = [string]$EdgeDriver.executableSha256
        versionProbeExitCode = [int]$EdgeDriver.versionProbeExitCode
        serviceStarted = $false
      }
    }
    noLaunch = [ordered]@{ appLaunched = $false; driverServiceStarted = $false; guiTested = $false }
    stagedAtUtc = $StagedAtUtc
  }
}

function New-FirstLaunchStage {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string] $Token, [Parameter(Mandatory = $true)][string] $CargoPath)
  $identity = Get-FirstLaunchGateIdentity
  $stageName = 'morrow-e003-g23-stage-' + [string]$identity.gate.sourceSha + '-' + [string]$identity.gate.gateRunId + '-1'
  $stageRoot = Join-Path ([string]$identity.runner.tempRoot) $stageName
  [void](Assert-FirstLaunchLiveStageRoot $stageRoot)
  $action = {
    param($claim, $token, $trustedCargoPath, $stageIdentity)
    $package = Get-FirstLaunchVerifiedPackage -Token $token -StageRoot $claim.stageRoot -StageOwnerToken $claim.token
    $runtime = Get-FirstLaunchWebView2Observation
    $tauri = Get-FirstLaunchTauriDriver -CargoPath $trustedCargoPath -StageRoot $claim.stageRoot -StageOwnerToken $claim.token
    $edge = Get-FirstLaunchEdgeDriver -RuntimeVersion ([string]$runtime.version) -StageRoot $claim.stageRoot -StageOwnerToken $claim.token
    $stage = New-FirstLaunchStageDto -Identity $stageIdentity -PackageResult $package -Runtime $runtime `
      -TauriDriver $tauri -EdgeDriver $edge -StagedAtUtc (Get-FirstLaunchUtcMilliseconds)
    $stagePath = Join-Path $claim.stageRoot 'stage.json'
    $stageText = ConvertTo-Json -InputObject $stage -Depth 20
    $stageBytes = [Text.UTF8Encoding]::new($false).GetBytes($stageText + "`n")
    [void](Assert-FirstLaunchStageClaim $claim.stageRoot $claim.token)
    Write-FirstLaunchNewFile $stagePath $stageBytes
    return [pscustomobject]@{
      stage = $stage
      stagePath = $stagePath
      stageSha256 = Get-Sha256 $stagePath
      packageReceiptPath = [string]$package.receiptPath
    }
  }.GetNewClosure()
  return (Invoke-FirstLaunchOwnedStage -StageRoot $stageRoot -Action $action -ActionArguments @($Token, $CargoPath, $identity))
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

if ($ProcessShim) {
  try {
    if ($LibraryOnly) { throw 'The private process shim cannot load as a library.' }
    Invoke-FirstLaunchProcessShim -RequestPath $ProcessRequestPath -RequestSha256 $ProcessRequestSha256 `
      -ShimScriptSha256 $ProcessShimScriptSha256
    exit 0
  } catch {
    exit 1
  }
}

if (-not $LibraryOnly) {
  throw 'This file is a package preflight library; import it with -LibraryOnly from the authorized orchestrator.'
}
