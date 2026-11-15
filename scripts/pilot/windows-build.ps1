$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$tauriRoot = Join-Path $repoRoot 'src-tauri'
$runId = $env:GITHUB_RUN_ID
$runAttempt = $env:GITHUB_RUN_ATTEMPT
$sha = $env:GITHUB_SHA
$runDir = Join-Path $env:RUNNER_TEMP "issue-166-$sha-$runId-$runAttempt"
$evidenceDir = Join-Path $runDir 'evidence'
$logsDir = Join-Path $evidenceDir 'logs'
$workDir = Join-Path $runDir 'work'
$packageDir = Join-Path $workDir 'package'
$fixtureDir = Join-Path $packageDir 'DemoVault'
$extractionDir = Join-Path $workDir 'extracted'
$candidateDir = Join-Path $runDir 'candidate'
$tempZip = Join-Path $workDir "morrow-polaris-dados-windows-$runId-$runAttempt-$sha.zip"
$commands = [System.Collections.Generic.List[object]]::new()
$gateResults = [System.Collections.Generic.List[object]]::new()
$versions = [ordered]@{}
$metadata = $null
$packageResult = $null
$pipelineStatus = 'failed'
$failure = $null
$exitCode = 1
$scriptStartedAt = [DateTimeOffset]::UtcNow
$packageStartedAt = $null
$packageVerifiedAt = $null

New-Item -ItemType Directory -Path $logsDir, $workDir -Force | Out-Null

function Protect-Log([string] $Text) {
  $safe = [regex]::Replace($Text, '\x1B\[[0-?]*[ -/]*[@-~]', '')
  $safe = [regex]::Replace($safe, '(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,})\b', '[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(authorization\s*:\s*bearer\s+)[^\s]+', '$1[REDACTED]')
  return $safe
}

function Invoke-LoggedCommand(
  [string] $Label,
  [string] $Executable,
  [string[]] $Arguments,
  [string] $WorkingDirectory
) {
  $started = [DateTimeOffset]::UtcNow
  $index = $script:commands.Count + 1
  $logName = '{0:D2}-{1}.log' -f $index, $Label
  $logPath = Join-Path $logsDir $logName
  $displayCommand = (@($Executable) + @($Arguments)) -join ' '
  $outputLines = @()
  $nativeExitCode = 127
  Write-Host "> $displayCommand (cwd: $WorkingDirectory)"

  Push-Location -LiteralPath $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $outputLines = @(& $Executable @Arguments 2>&1)
    $nativeExitCode = [int]$LASTEXITCODE
  } catch {
    $outputLines += $_.Exception.Message
    $nativeExitCode = 127
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }

  $finished = [DateTimeOffset]::UtcNow
  $rawText = ($outputLines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
  $safeText = Protect-Log $rawText
  [IO.File]::WriteAllText($logPath, $safeText, [Text.UTF8Encoding]::new($false))
  if ($safeText.Length -gt 0) { Write-Host $safeText }

  $relativeWorkingDirectory = [IO.Path]::GetRelativePath($repoRoot, $WorkingDirectory).Replace('\', '/')
  $commandRecord = [ordered]@{
    label = $Label
    command = $displayCommand
    workingDirectory = if ($relativeWorkingDirectory.Length -eq 0) { '.' } else { $relativeWorkingDirectory }
    startedAt = $started.ToString('o')
    finishedAt = $finished.ToString('o')
    durationMs = [math]::Round(($finished - $started).TotalMilliseconds, 0)
    exitCode = $nativeExitCode
    log = "logs/$logName"
    logSha256 = Get-Sha256 $logPath
  }
  $script:commands.Add($commandRecord)

  return [pscustomobject]@{
    Label = $Label
    ExitCode = $nativeExitCode
    Output = $safeText
    StartedAt = $started.ToString('o')
    FinishedAt = $finished.ToString('o')
  }
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PackageFiles([string] $Root) {
  return @(Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Sort-Object {
    [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
  })
}

function Write-BuildInfo([string] $Path) {
  $buildInfo = [ordered]@{
    schemaVersion = 1
    scope = 'Morrow E003-G07 issue 166'
    validationBoundary = 'Windows compile and package verification only; no application or GUI launch'
    run = @{ id = $runId; attempt = $runAttempt; sha = $sha }
    applicationVersion = $metadata.applicationVersion
    git = $metadata.git
    runner = $metadata.runner
    versions = $metadata.versions
    lockHashes = $metadata.lockHashes
    overlay = $metadata.overlay
    buildCommands = $gateResults.ToArray()
  }
  $json = $buildInfo | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

try {
  if ([string]::IsNullOrWhiteSpace($runId) -or [string]::IsNullOrWhiteSpace($runAttempt) -or [string]::IsNullOrWhiteSpace($sha)) {
    throw 'Required GitHub Actions run metadata is unavailable.'
  }

  $gitHead = Invoke-LoggedCommand 'git-head' 'git' @('rev-parse', 'HEAD') $repoRoot
  $gitTree = Invoke-LoggedCommand 'git-tree' 'git' @('rev-parse', 'HEAD^{tree}') $repoRoot
  $gitBranch = Invoke-LoggedCommand 'git-branch' 'git' @('branch', '--show-current') $repoRoot
  $gitStatus = Invoke-LoggedCommand 'git-status' 'git' @('status', '--porcelain', '--untracked-files=all') $repoRoot
  foreach ($item in @($gitHead, $gitTree, $gitBranch, $gitStatus)) {
    if ($item.ExitCode -ne 0) { throw "Git metadata command failed: $($item.Label)" }
  }
  if ($gitHead.Output.Trim() -ne $sha) { throw 'Checked-out commit does not match the triggering SHA.' }
  if ($gitBranch.Output.Trim() -ne 'pilot/e003-polaris-dados-2.0') { throw 'Workflow ran from an unexpected branch.' }
  if ($gitStatus.Output.Trim().Length -ne 0) { throw 'Checkout was not clean before build steps.' }

  $versionCommands = @(
    @{ Label = 'node-version'; Executable = 'node'; Arguments = @('--version') },
    @{ Label = 'npm-version'; Executable = 'npm'; Arguments = @('--version') },
    @{ Label = 'cargo-version'; Executable = 'cargo'; Arguments = @('--version') },
    @{ Label = 'rustc-version'; Executable = 'rustc'; Arguments = @('--version') },
    @{ Label = 'rustfmt-version'; Executable = 'rustfmt'; Arguments = @('--version') },
    @{ Label = 'clippy-version'; Executable = 'cargo'; Arguments = @('clippy', '--version') }
  )
  foreach ($item in $versionCommands) {
    $result = Invoke-LoggedCommand $item.Label $item.Executable $item.Arguments $repoRoot
    if ($result.ExitCode -ne 0) { throw "Version command failed: $($item.Label)" }
    $versions[$item.Label] = $result.Output.Trim()
  }

  $overlayPath = Join-Path $tauriRoot 'tauri.pilot.conf.json'
  $tauriConfigPath = Join-Path $tauriRoot 'tauri.conf.json'
  $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  $overlay = Get-Content -LiteralPath $overlayPath -Raw | ConvertFrom-Json
  $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
  $resourceMapping = $tauriConfig.bundle.resources.PSObject.Properties['../dist-mcp/index.js'].Value
  if ($overlay.identifier -ne 'app.morrow.polaris-dados-pilot') { throw 'Pilot Tauri identifier differs from the expected isolated identifier.' }
  if ($overlay.bundle.active -ne $false) { throw 'Pilot Tauri bundle must remain disabled for this debug build.' }
  if ($resourceMapping -ne 'mcp/index.js') { throw 'Tauri MCP resource mapping differs from the expected mcp/index.js path.' }

  $metadata = [ordered]@{
    git = [ordered]@{
      branch = $gitBranch.Output.Trim()
      head = $gitHead.Output.Trim()
      tree = $gitTree.Output.Trim()
      status = 'clean'
    }
    runner = [ordered]@{
      os = $env:RUNNER_OS
      architecture = $env:RUNNER_ARCH
      name = $env:RUNNER_NAME
      imageOs = $env:ImageOS
      imageVersion = $env:ImageVersion
      workflowRef = $env:GITHUB_REF
      eventName = $env:GITHUB_EVENT_NAME
    }
    applicationVersion = $packageJson.version
    versions = $versions
    lockHashes = [ordered]@{
      packageLock = Get-Sha256 (Join-Path $repoRoot 'package-lock.json')
      cargoLock = Get-Sha256 (Join-Path $tauriRoot 'Cargo.lock')
    }
    overlay = [ordered]@{
      path = 'src-tauri/tauri.pilot.conf.json'
      sha256 = Get-Sha256 $overlayPath
      identifier = $overlay.identifier
      bundleActive = [bool]$overlay.bundle.active
      mcpResourceSource = '../dist-mcp/index.js'
      mcpResourceTarget = $resourceMapping
    }
  }

  $buildPlan = @(
    @{ Label = 'npm-ci'; Executable = 'npm'; Arguments = @('ci'); WorkingDirectory = $repoRoot },
    @{ Label = 'npm-check'; Executable = 'npm'; Arguments = @('run', 'check'); WorkingDirectory = $repoRoot },
    @{ Label = 'cargo-fmt'; Executable = 'cargo'; Arguments = @('fmt', '--check'); WorkingDirectory = $tauriRoot },
    @{ Label = 'cargo-clippy'; Executable = 'cargo'; Arguments = @('clippy', '--locked', '--all-targets', '--', '-D', 'warnings'); WorkingDirectory = $tauriRoot },
    @{ Label = 'cargo-test'; Executable = 'cargo'; Arguments = @('test', '--locked'); WorkingDirectory = $tauriRoot },
    @{ Label = 'tauri-windows-debug-build'; Executable = 'npm'; Arguments = @('run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.pilot.conf.json'); WorkingDirectory = $repoRoot },
    @{ Label = 'polaris-dados-plugin-build'; Executable = 'npm'; Arguments = @('run', 'build:polaris-dados'); WorkingDirectory = $repoRoot }
  )

  foreach ($item in $buildPlan) {
    $result = Invoke-LoggedCommand $item.Label $item.Executable $item.Arguments $item.WorkingDirectory
    $stepStatus = if ($result.ExitCode -eq 0) { 'passed' } else { 'failed' }
    $gateResults.Add([ordered]@{
      label = $item.Label
      command = (@($item.Executable) + @($item.Arguments)) -join ' '
      startedAt = $result.StartedAt
      finishedAt = $result.FinishedAt
      exitCode = $result.ExitCode
      status = $stepStatus
    })
    if ($result.ExitCode -ne 0) { throw "Build gate failed: $($item.Label) (exit $($result.ExitCode))." }
  }

  $packageStartedAt = [DateTimeOffset]::UtcNow
  New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
  $exeSource = Join-Path $tauriRoot 'target/debug/morrow.exe'
  $mcpSource = Join-Path $repoRoot 'dist-mcp/index.js'
  $requiredSources = @(
    $exeSource,
    $mcpSource,
    (Join-Path $repoRoot 'dist/polaris-dados/main.js'),
    (Join-Path $repoRoot 'plugins/polaris-dados/manifest.json'),
    (Join-Path $repoRoot 'plugins/polaris-dados/README.md'),
    (Join-Path $repoRoot 'LICENSE')
  )
  foreach ($requiredSource in $requiredSources) {
    if (-not (Test-Path -LiteralPath $requiredSource -PathType Leaf)) { throw "Required build/package input is missing: $requiredSource" }
    if ((Get-Item -LiteralPath $requiredSource).Length -le 0) { throw "Required build/package input is empty: $requiredSource" }
  }

  Copy-Item -LiteralPath $exeSource -Destination (Join-Path $packageDir 'morrow.exe')
  $mcpTarget = Join-Path $packageDir 'mcp/index.js'
  New-Item -ItemType Directory -Path (Split-Path -Parent $mcpTarget) -Force | Out-Null
  Copy-Item -LiteralPath $mcpSource -Destination $mcpTarget
  $fixtureResult = Invoke-LoggedCommand 'create-synthetic-fixture' 'node' @('scripts/pilot/create-polaris-dados-fixture.mjs', $fixtureDir) $repoRoot
  if ($fixtureResult.ExitCode -ne 0) { throw "Synthetic fixture generation failed (exit $($fixtureResult.ExitCode))." }

  $fixturePlugin = Join-Path $fixtureDir '.morrow/plugins/polaris-dados'
  $fixtureComparisons = @(
    @{ Source = (Join-Path $repoRoot 'dist/polaris-dados/main.js'); Package = (Join-Path $fixturePlugin 'main.js'); Name = 'plugin bundle' },
    @{ Source = (Join-Path $repoRoot 'plugins/polaris-dados/manifest.json'); Package = (Join-Path $fixturePlugin 'manifest.json'); Name = 'plugin manifest' },
    @{ Source = (Join-Path $repoRoot 'plugins/polaris-dados/README.md'); Package = (Join-Path $fixturePlugin 'README.md'); Name = 'plugin README' },
    @{ Source = (Join-Path $repoRoot 'LICENSE'); Package = (Join-Path $fixturePlugin 'LICENSE'); Name = 'Apache-2.0 license' }
  )
  foreach ($item in $fixtureComparisons) {
    if (-not (Test-Path -LiteralPath $item.Package -PathType Leaf)) { throw "Package is missing $($item.Name)." }
    if ((Get-Sha256 $item.Source) -ne (Get-Sha256 $item.Package)) { throw "Packaged $($item.Name) hash differs from its source." }
  }
  if (-not (Test-Path -LiteralPath $mcpTarget -PathType Leaf)) { throw 'Package is missing the Tauri MCP resource at mcp/index.js.' }

  Write-BuildInfo (Join-Path $packageDir 'BUILD-INFO.json')
  $payloadFiles = @(Get-PackageFiles $packageDir)
  $sumLines = foreach ($file in $payloadFiles) {
    $relative = [IO.Path]::GetRelativePath($packageDir, $file.FullName).Replace('\', '/')
    "$(Get-Sha256 $file.FullName)  $relative"
  }
  [IO.File]::WriteAllLines((Join-Path $packageDir 'SHA256SUMS'), [string[]]$sumLines, [Text.UTF8Encoding]::new($false))

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($packageDir, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $false)
  [IO.Compression.ZipFile]::ExtractToDirectory($tempZip, $extractionDir)
  $extractedFiles = @(Get-PackageFiles $extractionDir)
  $expectedNames = @($payloadFiles | ForEach-Object { [IO.Path]::GetRelativePath($packageDir, $_.FullName).Replace('\', '/') } | Sort-Object)
  $actualNames = @($extractedFiles | ForEach-Object { [IO.Path]::GetRelativePath($extractionDir, $_.FullName).Replace('\', '/') } | Where-Object { $_ -ne 'SHA256SUMS' } | Sort-Object)
  if (Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames) { throw 'ZIP extraction produced a different file inventory.' }

  $checksumMap = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath (Join-Path $extractionDir 'SHA256SUMS')) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "Invalid SHA256SUMS line: $line" }
    $checksumMap[$Matches[2]] = $Matches[1]
  }
  if ($checksumMap.Count -ne $payloadFiles.Count) { throw 'SHA256SUMS does not cover every payload file.' }
  foreach ($relative in $expectedNames) {
    $extractedPath = Join-Path $extractionDir ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not $checksumMap.Contains($relative)) { throw "SHA256SUMS is missing $relative." }
    if ((Get-Sha256 $extractedPath) -ne $checksumMap[$relative]) { throw "Extracted file hash mismatch: $relative" }
  }
  if ((Get-Sha256 (Join-Path $extractionDir 'morrow.exe')) -ne (Get-Sha256 $exeSource)) { throw 'The extracted executable hash differs from the Windows build output.' }
  if ((Get-Sha256 (Join-Path $extractionDir 'mcp/index.js')) -ne (Get-Sha256 $mcpSource)) { throw 'The extracted Tauri MCP resource hash differs from dist-mcp/index.js.' }
  if ((Get-Sha256 (Join-Path $extractionDir 'DemoVault/.morrow/plugins/polaris-dados/main.js')) -ne (Get-Sha256 (Join-Path $repoRoot 'dist/polaris-dados/main.js'))) { throw 'The extracted plugin bundle hash differs from the built plugin.' }
  $packageVerifiedAt = [DateTimeOffset]::UtcNow

  $fileInventory = foreach ($file in $payloadFiles) {
    [ordered]@{
      path = [IO.Path]::GetRelativePath($packageDir, $file.FullName).Replace('\', '/')
      sizeBytes = $file.Length
      sha256 = Get-Sha256 $file.FullName
    }
  }
  $zipInfo = Get-Item -LiteralPath $tempZip
  $packageResult = [ordered]@{
    status = 'passed'
    startedAt = $packageStartedAt.ToString('o')
    verifiedAt = $packageVerifiedAt.ToString('o')
    layout = 'morrow.exe; mcp/index.js; DemoVault/.morrow/plugins/polaris-dados/{main.js,manifest.json,README.md,LICENSE}; fixture data; BUILD-INFO.json; SHA256SUMS'
    executableLaunched = $false
    zip = [ordered]@{ name = [IO.Path]::GetFileName($tempZip); sizeBytes = $zipInfo.Length; sha256 = Get-Sha256 $tempZip }
    sha256sumsSha256 = Get-Sha256 (Join-Path $packageDir 'SHA256SUMS')
    extractedExecutableSha256 = Get-Sha256 (Join-Path $extractionDir 'morrow.exe')
    files = @($fileInventory)
    verification = [ordered]@{
      zipCreated = $true
      extractedToCleanDirectory = $true
      inventoryMatched = $true
      sha256sumsMatched = $true
      executableHashMatched = $true
      mcpResourceHashMatched = $true
      pluginBundleHashMatched = $true
    }
  }

  New-Item -ItemType Directory -Path $candidateDir -Force | Out-Null
  $candidateZip = Join-Path $candidateDir ([IO.Path]::GetFileName($tempZip))
  Move-Item -LiteralPath $tempZip -Destination $candidateZip
  $packageResult.zip.path = $candidateZip
  $pipelineStatus = 'passed'
  $exitCode = 0
} catch {
  $failure = Protect-Log $_.Exception.Message
  Write-Host "::error::$failure"
} finally {
  $finishedAt = [DateTimeOffset]::UtcNow
  $receipt = [ordered]@{
    schemaVersion = 1
    issue = 166
    status = $pipelineStatus
    startedAt = $scriptStartedAt.ToString('o')
    finishedAt = $finishedAt.ToString('o')
    run = [ordered]@{ id = $runId; attempt = $runAttempt; sha = $sha; ref = $env:GITHUB_REF }
    metadata = $metadata
    commands = $commands.ToArray()
    gates = $gateResults.ToArray()
    package = $packageResult
    failure = $failure
    appLaunched = $false
  }
  $receiptJson = $receipt | ConvertTo-Json -Depth 16
  [IO.File]::WriteAllText((Join-Path $evidenceDir 'receipt.json'), $receiptJson, [Text.UTF8Encoding]::new($false))
  Write-Host "Build receipt: $(Join-Path $evidenceDir 'receipt.json')"
}

exit $exitCode
