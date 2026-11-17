[CmdletBinding()]
param(
  [string] $PackagePath = $PSScriptRoot,
  [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:PilotIdentifier = 'app.morrow.polaris-dados-pilot'
$script:MarkerName = 'MORROW-PILOT-STATE.json'
$script:MarkerOwner = 'Morrow E003 Polaris Dados Windows pilot'
$script:MutexName = 'Local\Morrow-Polaris-Dados-Windows-Pilot'

function Get-NormalizedPackagePath([string] $Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw 'PackagePath must be an absolute local path.'
  }
  if ($Path.StartsWith('\\', [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith('\\.\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Network and device paths are not accepted.'
  }
  if ($Path.Length -gt 120) {
    throw 'The package path is too long for the Windows PowerShell 5.1 launcher. Extract the inner ZIP directly to a short folder such as Downloads\MorrowPiloto.'
  }

  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ($root -notmatch '^[A-Za-z]:\\$' -or [string]::Equals($fullPath.TrimEnd('\'), $root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PackagePath must be below a local drive root.'
  }
  if ($fullPath.Length -gt 120) {
    throw 'The package path is too long for the Windows PowerShell 5.1 launcher. Extract the inner ZIP directly to a short folder such as Downloads\MorrowPiloto.'
  }
  $provided = $Path.TrimEnd('\')
  if (-not [string]::Equals($provided, $fullPath.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PackagePath must be normalized and must not contain dot segments.'
  }

  $drive = [IO.DriveInfo]::new($root)
  if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) {
    throw 'PackagePath must be on a ready local fixed drive.'
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
    throw 'The package directory does not exist.'
  }
  return $fullPath.TrimEnd('\')
}

function Assert-NoReparsePath([string] $Path, [string] $Label) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ($root -notmatch '^[A-Za-z]:\\$') { throw "$Label is not on a local drive." }
  $remaining = $fullPath.Substring($root.Length)
  $current = $root
  foreach ($segment in $remaining.Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $segment)
    if (-not (Test-Path -LiteralPath $current)) { break }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label crosses a reparse point or junction: $current"
    }
  }
}

function Get-RelativePackagePath([string] $Root, [string] $Path) {
  $rootPrefix = $Root.TrimEnd('\') + '\'
  if (-not $Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A package path escaped the package directory.'
  }
  return $Path.Substring($rootPrefix.Length).Replace('\', '/')
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Text([string] $Text) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $digest = $algorithm.ComputeHash($bytes)
    return ([BitConverter]::ToString($digest).Replace('-', '')).ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-TreeEntries([string] $Root, [switch] $SkipPilotState) {
  $entries = New-Object System.Collections.ArrayList
  $directories = New-Object System.Collections.Stack
  $directories.Push($Root)
  while ($directories.Count -gt 0) {
    $directory = [string]$directories.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "A package or vault path contains a reparse point or junction: $entryPath"
      }
      $relative = Get-RelativePackagePath $Root $entryPath
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        if ($SkipPilotState -and $relative -eq 'PilotState') { continue }
        $directories.Push($entryPath)
      } else {
        [void]$entries.Add([pscustomobject]@{
          path = $relative
          fullPath = $entryPath
          sizeBytes = (Get-Item -LiteralPath $entryPath).Length
          sha256 = Get-Sha256 $entryPath
        })
      }
    }
  }
  return @($entries | Sort-Object -Property path)
}

function Assert-NoReparseTree([string] $Root, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
  $directories = New-Object System.Collections.Stack
  $directories.Push($Root)
  while ($directories.Count -gt 0) {
    $directory = [string]$directories.Pop()
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point or junction: $entryPath"
      }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $directories.Push($entryPath) }
    }
  }
}

function Get-TemplateTreeHash([string] $Root) {
  $entries = @(Get-TreeEntries $Root)
  $lines = [string[]]@(
    foreach ($entry in $entries) { '{0}  {1}' -f $entry.path, $entry.sha256 }
  )
  [Array]::Sort($lines, [StringComparer]::Ordinal)
  return Get-Sha256Text (($lines -join "`n") + "`n")
}

function Get-RequiredPackageFiles {
  return @(
    'BUILD-INFO.json',
    'morrow.exe',
    'mcp/index.js',
    'DemoVault/.morrow/plugins/polaris-dados/main.js',
    'DemoVault/.morrow/plugins/polaris-dados/manifest.json',
    'DemoVault/.morrow/plugins/polaris-dados/README.md',
    'DemoVault/.morrow/plugins/polaris-dados/LICENSE',
    'windows-launch.ps1',
    'windows-launch.cmd',
    'TESTAR-NO-WINDOWS.md'
  )
}

function Read-BuildInfo([string] $Root) {
  $buildInfoPath = Join-Path $Root 'BUILD-INFO.json'
  if (-not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) { throw 'BUILD-INFO.json is missing.' }
  try { return Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'BUILD-INFO.json is not valid JSON.' }
}

function Assert-PackageIntegrity([string] $Root) {
  Assert-NoReparsePath $Root 'Package root'
  $actualEntries = @(Get-TreeEntries $Root -SkipPilotState)
  $actualByPath = @{}
  foreach ($entry in $actualEntries) {
    if ($actualByPath.ContainsKey($entry.path)) { throw "Duplicate package path: $($entry.path)" }
    $actualByPath[$entry.path] = $entry
  }

  foreach ($relative in (Get-RequiredPackageFiles)) {
    if (-not $actualByPath.ContainsKey($relative)) { throw "Required package file is missing: $relative" }
    if ($actualByPath[$relative].sizeBytes -le 0) { throw "Required package file is empty: $relative" }
  }

  $buildInfo = Read-BuildInfo $Root
  if ($buildInfo.schemaVersion -ne 1 -or $buildInfo.scope -ne 'Morrow E003-G12 issue 178') { throw 'BUILD-INFO scope or schema is not the expected Windows pilot package.' }
  if ($buildInfo.sourceBuildPlatform -ne 'windows-native' -or $buildInfo.appLaunched -ne $false -or $buildInfo.windowsRuntimeTested -ne $false) {
    throw 'BUILD-INFO must identify a native Windows build with no application launch or Windows runtime test.'
  }
  if ($buildInfo.pilotIdentifier -ne $script:PilotIdentifier) { throw 'BUILD-INFO pilot identifier is unexpected.' }
  if ($buildInfo.git.status -ne 'clean' -or $buildInfo.git.head -ne $buildInfo.run.sha -or $buildInfo.runner.os -ne 'Windows' -or $buildInfo.runner.architecture -ne 'X64') {
    throw 'BUILD-INFO provenance does not describe a clean native Windows x64 build.'
  }
  if ($buildInfo.overlay.path -ne 'src-tauri/tauri.pilot.conf.json' -or $buildInfo.overlay.identifier -ne $script:PilotIdentifier -or $buildInfo.overlay.bundleActive -ne $false -or $buildInfo.overlay.mcpResourceSource -ne '../dist-mcp/index.js' -or $buildInfo.overlay.mcpResourceTarget -ne 'mcp/index.js') {
    throw 'BUILD-INFO does not identify the isolated no-bundle Tauri overlay and MCP resource mapping.'
  }
  $debugBuild = @($buildInfo.buildCommands | Where-Object { $_.label -eq 'tauri-windows-debug-build' })
  if ($debugBuild.Count -ne 1 -or $debugBuild[0].status -ne 'passed' -or $debugBuild[0].command -notmatch '--debug' -or $debugBuild[0].command -notmatch '--no-bundle' -or $debugBuild[0].command -notmatch 'tauri\.pilot\.conf\.json') {
    throw 'BUILD-INFO does not prove a passing pilot debug build with bundling disabled.'
  }
  if ($buildInfo.template.path -ne 'DemoVault' -or $buildInfo.template.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'BUILD-INFO template metadata is invalid.' }
  if ((Get-TemplateTreeHash (Join-Path $Root 'DemoVault')) -ne $buildInfo.template.sha256) { throw 'The immutable DemoVault template hash does not match BUILD-INFO.json.' }

  $inventoryEntries = @($actualEntries | Where-Object { $_.path -ne 'BUILD-INFO.json' -and $_.path -ne 'SHA256SUMS' })
  $fileInventory = @($buildInfo.fileInventory)
  if ($fileInventory.Count -ne $inventoryEntries.Count) { throw 'BUILD-INFO file inventory does not cover the package payload.' }
  $infoByPath = @{}
  foreach ($item in $fileInventory) {
    if ($null -eq $item.path -or $item.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $item.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'BUILD-INFO contains an invalid package inventory entry.'
    }
    if ($infoByPath.ContainsKey([string]$item.path)) { throw "BUILD-INFO has a duplicate inventory path: $($item.path)" }
    $infoByPath[[string]$item.path] = $item
  }

  foreach ($entry in $inventoryEntries) {
    if (-not $infoByPath.ContainsKey($entry.path)) { throw "BUILD-INFO is missing package payload: $($entry.path)" }
    $expected = $infoByPath[$entry.path]
    if ([long]$expected.sizeBytes -ne [long]$entry.sizeBytes -or [string]$expected.sha256 -ne $entry.sha256) {
      throw "Package payload differs from BUILD-INFO: $($entry.path)"
    }
  }

  $sumsPath = Join-Path $Root 'SHA256SUMS'
  if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) { throw 'SHA256SUMS is missing.' }
  $sumMap = @{}
  foreach ($line in (Get-Content -LiteralPath $sumsPath)) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw 'SHA256SUMS has an invalid line.' }
    $relative = $Matches[2]
    if ($relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $relative -eq 'SHA256SUMS') { throw 'SHA256SUMS has an invalid payload path.' }
    if ($sumMap.ContainsKey($relative)) { throw "SHA256SUMS repeats a path: $relative" }
    $sumMap[$relative] = $Matches[1]
  }
  if ($sumMap.Count -ne ($actualEntries.Count - 1)) { throw 'SHA256SUMS does not cover the exact payload and BUILD-INFO.json.' }
  foreach ($entry in @($actualEntries | Where-Object { $_.path -ne 'SHA256SUMS' })) {
    if (-not $sumMap.ContainsKey($entry.path) -or $sumMap[$entry.path] -ne $entry.sha256) { throw "SHA256SUMS mismatch: $($entry.path)" }
  }
  $buildInfoHash = Get-Sha256 (Join-Path $Root 'BUILD-INFO.json')
  if (-not $sumMap.ContainsKey('BUILD-INFO.json') -or $sumMap['BUILD-INFO.json'] -ne $buildInfoHash) { throw 'SHA256SUMS mismatch: BUILD-INFO.json' }

  return [pscustomobject]@{
    BuildInfo = $buildInfo
    Entries = $actualEntries
    TemplateHash = [string]$buildInfo.template.sha256
  }
}

function Get-StatePaths([string] $Root) {
  $stateRoot = Join-Path $Root 'PilotState'
  return [pscustomobject]@{
    Root = $stateRoot
    Marker = Join-Path $stateRoot $script:MarkerName
    DemoVault = Join-Path $stateRoot 'DemoVault'
    MorrowUserData = Join-Path $stateRoot 'MorrowUserData'
    WebView2UserData = Join-Path $stateRoot 'WebView2UserData'
  }
}

function Inspect-PilotState([string] $Root) {
  $paths = Get-StatePaths $Root
  Assert-NoReparsePath $paths.Root 'PilotState'
  if (-not (Test-Path -LiteralPath $paths.Root)) {
    return [pscustomobject]@{ Status = 'new'; Paths = $paths; Marker = $null }
  }
  if (-not (Test-Path -LiteralPath $paths.Root -PathType Container)) { throw 'PilotState collides with a non-directory path.' }
  if (-not (Test-Path -LiteralPath $paths.Marker -PathType Leaf)) { throw 'PilotState exists without its ownership marker; refusing uncertain state.' }
  Assert-NoReparsePath $paths.Marker 'PilotState marker'
  try { $marker = Get-Content -LiteralPath $paths.Marker -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'PilotState ownership marker is not valid JSON; refusing uncertain state.' }
  if ($marker.schemaVersion -ne 1 -or $marker.owner -ne $script:MarkerOwner -or $marker.pilotIdentifier -ne $script:PilotIdentifier -or $marker.stateDirectory -ne 'PilotState' -or $marker.demoVaultRelativePath -ne 'PilotState/DemoVault' -or $marker.templateSha256AtInitialization -notmatch '^[0-9a-f]{64}$') {
    throw 'PilotState ownership marker is not recognized; refusing uncertain state.'
  }
  if (-not (Test-Path -LiteralPath $paths.DemoVault -PathType Container)) { throw 'The owned mutable DemoVault is missing; refusing to recreate it.' }
  Assert-NoReparsePath $paths.DemoVault 'Mutable DemoVault'
  Assert-NoReparseTree $paths.DemoVault 'Mutable DemoVault'
  foreach ($directory in @($paths.MorrowUserData, $paths.WebView2UserData)) {
    Assert-NoReparsePath $directory 'PilotState runtime directory'
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'A marked PilotState runtime directory is missing or is not a directory.' }
    Assert-NoReparseTree $directory 'PilotState runtime directory'
  }
  return [pscustomobject]@{ Status = 'owned'; Paths = $paths; Marker = $marker }
}

function New-PilotProcessStartInfo([string] $Root, [object] $State) {
  $executable = Join-Path $Root 'morrow.exe'
  $paths = $State.Paths
  Assert-NoReparsePath $executable 'Morrow executable'
  Assert-NoReparsePath $Root 'Package working directory'
  Assert-NoReparsePath $paths.MorrowUserData 'MORROW_USER_DATA'
  Assert-NoReparsePath $paths.WebView2UserData 'WEBVIEW2_USER_DATA_FOLDER'

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $executable
  $startInfo.WorkingDirectory = $Root
  $startInfo.UseShellExecute = $false
  $startInfo.EnvironmentVariables['MORROW_USER_DATA'] = $paths.MorrowUserData
  $startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = $paths.WebView2UserData
  $statePrefix = $paths.Root.TrimEnd('\') + '\'
  $morrowUserData = $startInfo.EnvironmentVariables['MORROW_USER_DATA']
  $webViewUserData = $startInfo.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER']
  if ($startInfo.FileName -ne $executable -or $startInfo.WorkingDirectory -ne $Root -or $startInfo.UseShellExecute -or -not [IO.Path]::IsPathRooted($morrowUserData) -or -not [IO.Path]::IsPathRooted($webViewUserData) -or -not $morrowUserData.StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase) -or -not $webViewUserData.StartsWith($statePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The child process environment could not be prepared with absolute PilotState paths.'
  }
  return $startInfo
}

function Assert-NoRunningMorrow {
  try { $running = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'morrow' }) }
  catch { throw 'Could not reliably inspect running processes; refusing to launch.' }
  if ($running.Count -gt 0) { throw 'Another morrow.exe process is running. Close it manually, then try again.' }
}

function Copy-TemplateToPilotState([string] $Source, [string] $Destination) {
  New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
  $directories = New-Object System.Collections.Stack
  $directories.Push($Source)
  while ($directories.Count -gt 0) {
    $sourceDirectory = [string]$directories.Pop()
    $relativeDirectory = if ($sourceDirectory -eq $Source) { '' } else { Get-RelativePackagePath $Source $sourceDirectory }
    $destinationDirectory = if ($relativeDirectory.Length -eq 0) { $Destination } else { Join-Path $Destination $relativeDirectory.Replace('/', [IO.Path]::DirectorySeparatorChar) }
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) { New-Item -ItemType Directory -Path $destinationDirectory -ErrorAction Stop | Out-Null }
    foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($sourceDirectory)) {
      $attributes = [IO.File]::GetAttributes($entryPath)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The immutable DemoVault template contains a reparse point.' }
      $name = [IO.Path]::GetFileName($entryPath)
      $destinationPath = Join-Path $destinationDirectory $name
      Assert-NoReparsePath $destinationPath 'PilotState copy destination'
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        $directories.Push($entryPath)
      } else {
        [IO.File]::Copy($entryPath, $destinationPath, $false)
      }
    }
  }
}

function Initialize-PilotState([string] $Root, [string] $TemplateHash) {
  $state = Inspect-PilotState $Root
  if ($state.Status -eq 'owned') { return $state }

  $paths = $state.Paths
  New-Item -ItemType Directory -Path $paths.Root -ErrorAction Stop | Out-Null
  Assert-NoReparsePath $paths.Root 'PilotState'
  Copy-TemplateToPilotState (Join-Path $Root 'DemoVault') $paths.DemoVault
  if ((Get-TemplateTreeHash $paths.DemoVault) -ne $TemplateHash) { throw 'The first mutable DemoVault copy failed its template hash check; state was left intact for inspection.' }
  New-Item -ItemType Directory -Path $paths.MorrowUserData, $paths.WebView2UserData -ErrorAction Stop | Out-Null

  $marker = [ordered]@{
    schemaVersion = 1
    owner = $script:MarkerOwner
    pilotIdentifier = $script:PilotIdentifier
    stateDirectory = 'PilotState'
    demoVaultRelativePath = 'PilotState/DemoVault'
    templateSha256AtInitialization = $TemplateHash
    createdAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $markerJson = $marker | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($paths.Marker, $markerJson, [Text.UTF8Encoding]::new($false))
  return Inspect-PilotState $Root
}

function Exit-WithCheckResult([string] $StateStatus, [bool] $ChildEnvironmentConfigured) {
  $result = [ordered]@{
    status = 'passed'
    appLaunched = $false
    stateWritten = $false
    packageVerified = $true
    childEnvironmentConfigured = $ChildEnvironmentConfigured
    childEnvironmentPathsArePilotStateChildren = $ChildEnvironmentConfigured
    stateStatus = $StateStatus
  }
  Write-Output ($result | ConvertTo-Json -Compress)
}

try {
  $packageRoot = Get-NormalizedPackagePath $PackagePath
  $integrity = Assert-PackageIntegrity $packageRoot
  $state = Inspect-PilotState $packageRoot
  $startInfo = New-PilotProcessStartInfo $packageRoot $state
  Assert-NoRunningMorrow

  if ($CheckOnly) {
    Exit-WithCheckResult $state.Status $true
    exit 0
  }

  $mutex = [System.Threading.Mutex]::new($false, $script:MutexName)
  $ownsMutex = $false
  $process = $null
  try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another Polaris Dados pilot launcher is active.' }

    Assert-NoRunningMorrow
    $state = Initialize-PilotState $packageRoot $integrity.TemplateHash
    $startInfo = New-PilotProcessStartInfo $packageRoot $state
    Assert-NoRunningMorrow
    Write-Host 'Starting the isolated Polaris Dados pilot. DemoVault is reserved under PilotState.'
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw 'Windows did not start morrow.exe.' }
    $process.WaitForExit()
    Write-Host "Morrow exited with code $($process.ExitCode)."
  } finally {
    if ($null -ne $process) { $process.Dispose() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  [Console]::Error.WriteLine("Morrow pilot launch refused: $($_.Exception.Message)")
  exit 1
}
