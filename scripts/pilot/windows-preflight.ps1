[CmdletBinding()]
param(
  [ValidateSet('Stage', 'CheckOnly')]
  [string] $Mode = 'CheckOnly',
  [switch] $LibraryOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Artifact = [ordered]@{
  repository = 'hodeliun/Morrow'
  runId = '43854570751'
  runAttempt = '1'
  sourceSha = '9d6d264828d9be8dd393f13d922f25bec1fe74b5'
  sourceTree = 'df94a7bafd5eb60bda5cbcf6f2fc112b3cff4709'
  artifactId = '14221286819'
  artifactName = 'morrow-polaris-dados-windows-build-43854570751-1-9d6d264828d9be8dd393f13d922f25bec1fe74b5'
  artifactSizeBytes = 31890998
  outerSha256 = '7ac7898e93f3c6b81cc0be80b20db3f7c4be2b540ebf95365a6f370f75560d7d'
  innerName = 'morrow-polaris-dados-windows-43854570751-1-9d6d264828d9be8dd393f13d922f25bec1fe74b5.zip'
  innerSizeBytes = 31938060
  innerSha256 = '2dfabfd3efdd48bc95ef139bf653d90c81fe802ca5699558f33aa14a9050de04'
  innerEntryCount = 16
  innerTotalBytes = 53660508
  fileInventoryCount = 14
  buildInfoSizeBytes = 6323
  buildInfoSha256 = '656398893d80fee9bd6b6626d291219233828a0394b9b3b9b6aebde5e247dcc1'
  sha256SumsSizeBytes = 1440
  sha256SumsSha256 = '566f542caf22373a08523de466f17da05ee62e59d54edb3ec7122107b3e90d40'
  launcherSha256 = '321b9e8cc723e292225ef3819110776363843bf6c85761a5e22ae9871bc2ef79'
  mcpResourceSha256 = '03678201ed39d3fed222bb9328eada9dd359eb0a550c26354be02f4f44699b40'
  overlayPath = 'src-tauri/tauri.pilot.conf.json'
  overlaySha256 = 'c2e8898d991f38da8418a0cdac156f163c0e8b968a3f03c601bac67d2bbbcf9f'
  mcpResourceSource = '../dist-mcp/index.js'
  mcpResourceTarget = 'mcp/index.js'
  demoVaultPath = 'DemoVault'
  demoVaultSha256 = '00bb5d0e6b97411e99995efe0247eb17f4cb4bde8fb4b7495c49deeab68bb4b2'
  executableSizeBytes = 51608064
  executableSha256 = 'c7dc0677a1fa254d08eb06856956a23e7f4729d27793b6a8cc65cc39282b68d3'
  pilotIdentifier = 'app.morrow.polaris-dados-pilot'
}
$script:OfficialEdgeDriverPageUrl = 'https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver'
$script:OfficialEdgeDriverCatalogUrl = 'https://msedgedriver.microsoft.com/listing.json'
$script:MaxOfficialCatalogBytes = 4MB
$script:MaxOfficialCatalogItems = 50000
$script:MaxOfficialDriverBytes = 64MB
$script:TauriDriver = [ordered]@{
  version = '2.1.0'
  sourceUrl = 'https://crates.io/crates/tauri-driver/2.1.0'
  downloadUrl = 'https://crates.io/api/v1/crates/tauri-driver/2.1.0/download'
}
$script:WebView2ClientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$script:MaxZipEntries = 256
$script:MaxZipEntryBytes = 128MB
$script:MaxZipTotalBytes = 256MB
$script:MaxZipPathChars = 220

function Add-PreflightCrcType {
  if ('MorrowPreflightCrc' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;

public static class MorrowPreflightCrc
{
    private static readonly uint[] Table = BuildTable();

    private static uint[] BuildTable()
    {
        var table = new uint[256];
        for (int i = 0; i < table.Length; i++)
        {
            uint value = (uint)i;
            for (int bit = 0; bit < 8; bit++)
                value = (value & 1) == 1 ? 0xEDB88320U ^ (value >> 1) : value >> 1;
            table[i] = value;
        }
        return table;
    }

    public static uint Compute(Stream stream)
    {
        uint crc = 0xFFFFFFFFU;
        var buffer = new byte[65536];
        int count;
        while ((count = stream.Read(buffer, 0, buffer.Length)) != 0)
        {
            for (int i = 0; i < count; i++)
                crc = Table[(int)((crc ^ buffer[i]) & 0xFF)] ^ (crc >> 8);
        }
        return crc ^ 0xFFFFFFFFU;
    }
}
'@
}

function Protect-Text([string] $Text) {
  $safe = [regex]::Replace($Text, '\x1B\[[0-?]*[ -/]*[@-~]', '')
  $safe = [regex]::Replace($safe, '(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_]{20,})\b', '[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(authorization\s*:\s*bearer\s+)[^\s]+', '$1[REDACTED]')
  $safe = [regex]::Replace($safe, '(?i)(https?://[^\s?]+)\?[^\s]+', '$1?[REDACTED]')
  if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) { $safe = $safe.Replace($env:USERPROFILE, '%USERPROFILE%') }
  if (-not [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { $safe = $safe.Replace($env:RUNNER_TEMP, '%RUNNER_TEMP%') }
  return $safe
}

function Get-Sha256([string] $Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SafeError([object] $ErrorRecord) {
  $message = [string]$ErrorRecord.Exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) { $message = [string]$ErrorRecord }
  return (Protect-Text $message)
}

function Assert-SafeDriverInvocation([string] $Executable, [string[]] $Arguments) {
  $name = [IO.Path]::GetFileName($Executable)
  if ($name -match '^(?i:tauri-driver)(?:\.exe)?$') {
    throw 'The tauri-driver executable is never started by this preflight; version comes from Cargo installation metadata.'
  }
  if ($name -match '^(?i:msedgedriver)(?:\.exe)?$' -and
      ($Arguments.Count -ne 1 -or $Arguments[0] -cne '--version')) {
    throw 'The only allowed msedgedriver invocation is the non-service --version probe.'
  }
}

function Assert-LocalNormalizedPath([string] $Path, [string] $Label) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty." }
  if ($Path.Contains('/') -or $Path.StartsWith('\\') -or $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\')) {
    throw "$Label must be a normalized local-drive path."
  }
  if ($Path -notmatch '^[A-Za-z]:\\') { throw "$Label must be rooted on a local drive." }
  $tail = $Path.Substring(3)
  if ($tail.Contains(':') -or $tail -match '(^|\\)\.\.?($|\\)' -or $tail.Contains('\\')) {
    throw "$Label contains an alternate stream, dot segment, or repeated separator."
  }
  foreach ($segment in $tail.Split([char]'\', [StringSplitOptions]::RemoveEmptyEntries)) {
    if ($segment.EndsWith('.') -or $segment.EndsWith(' ')) { throw "$Label contains a Windows path alias." }
    if ($segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
      throw "$Label contains a reserved Windows path component."
    }
  }
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [string]::Equals($full.TrimEnd('\'), $Path.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is not in normalized form."
  }
  return $full.TrimEnd('\')
}

function Assert-NoReparsePath([string] $Path, [string] $Label) {
  $full = Assert-LocalNormalizedPath $Path $Label
  $root = [IO.Path]::GetPathRoot($full)
  $remaining = $full.Substring($root.Length)
  $current = $root
  foreach ($segment in $remaining.Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $segment)
    if (-not [IO.File]::Exists($current) -and -not [IO.Directory]::Exists($current)) { break }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label crosses a reparse point or junction."
    }
  }
  return $full
}

function Assert-NoPathCollision([string] $Path, [string] $Label) {
  $full = Assert-NoReparsePath $Path $Label
  if ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full)) {
    throw "$Label already exists; the preflight will not remove or reuse it."
  }
  $parent = [IO.Path]::GetDirectoryName($full)
  $leaf = [IO.Path]::GetFileName($full)
  if ([IO.Directory]::Exists($parent)) {
    foreach ($existing in [IO.Directory]::EnumerateFileSystemEntries($parent)) {
      if ([string]::Equals([IO.Path]::GetFileName($existing), $leaf, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label collides with an existing case-insensitive path; the preflight will not alter it."
      }
    }
  }
  return $full
}

function Get-ZipEntryPath([string] $Name, [bool] $IsDirectory) {
  if ([string]::IsNullOrEmpty($Name) -or $Name.Contains([char]0) -or $Name.Contains('\') -or $Name.Contains(':')) {
    throw 'A ZIP entry has an empty name, backslash, NUL, or alternate-stream separator.'
  }
  if ($Name.StartsWith('/') -or $Name.Contains('//') -or $Name -match '^[A-Za-z]:') {
    throw 'A ZIP entry uses an absolute or drive-qualified path.'
  }
  $relative = if ($IsDirectory) { $Name.TrimEnd('/') } else { $Name }
  if ([string]::IsNullOrEmpty($relative) -or $relative.Length -gt $script:MaxZipPathChars) {
    throw 'A ZIP entry path is empty or exceeds the safe length limit.'
  }
  $segments = $relative.Split('/')
  foreach ($segment in $segments) {
    if ([string]::IsNullOrEmpty($segment) -or $segment -eq '.' -or $segment -eq '..' -or
        $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
      throw 'A ZIP entry contains an empty, dot, or aliased path component.'
    }
    if ($segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$') {
      throw 'A ZIP entry contains a reserved Windows path component.'
    }
  }
  return ($segments -join '/')
}

function Read-ZipCentralDirectory([string] $ArchivePath, [int] $ExpectedEntries) {
  $stream = [IO.File]::OpenRead($ArchivePath)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 22 -or $stream.Length -gt $script:MaxZipTotalBytes) {
      throw 'A ZIP archive is too small or exceeds the archive-size limit.'
    }
    $tailLength = [int][Math]::Min($stream.Length, 65557)
    [void]$stream.Seek(-$tailLength, [IO.SeekOrigin]::End)
    $tail = $reader.ReadBytes($tailLength)
    $eocdIndex = -1
    for ($index = $tail.Length - 22; $index -ge 0; $index--) {
      if ([BitConverter]::ToUInt32($tail, $index) -eq 0x06054b50) {
        $commentLength = [BitConverter]::ToUInt16($tail, $index + 20)
        if ($index + 22 + $commentLength -eq $tail.Length) { $eocdIndex = $index; break }
      }
    }
    if ($eocdIndex -lt 0) { throw 'A ZIP archive has no valid end-of-directory record.' }
    $diskNumber = [BitConverter]::ToUInt16($tail, $eocdIndex + 4)
    $directoryDisk = [BitConverter]::ToUInt16($tail, $eocdIndex + 6)
    $entriesOnDisk = [BitConverter]::ToUInt16($tail, $eocdIndex + 8)
    $entriesTotal = [BitConverter]::ToUInt16($tail, $eocdIndex + 10)
    $directorySize = [BitConverter]::ToUInt32($tail, $eocdIndex + 12)
    $directoryOffset = [BitConverter]::ToUInt32($tail, $eocdIndex + 16)
    $eocdOffset = $stream.Length - $tailLength + $eocdIndex
    if ($diskNumber -ne 0 -or $directoryDisk -ne 0 -or $entriesOnDisk -ne $entriesTotal -or
        $entriesTotal -eq 0xFFFF -or $directorySize -eq 0xFFFFFFFF -or $directoryOffset -eq 0xFFFFFFFF -or
        $entriesTotal -ne $ExpectedEntries -or $entriesTotal -gt $script:MaxZipEntries -or
        [long]$directoryOffset + [long]$directorySize -ne $eocdOffset) {
      throw 'A ZIP archive uses multi-disk/ZIP64 layout or has inconsistent directory metadata.'
    }
    [void]$stream.Seek([long]$directoryOffset, [IO.SeekOrigin]::Begin)
    $central = New-Object System.Collections.ArrayList
    for ($entryIndex = 0; $entryIndex -lt $entriesTotal; $entryIndex++) {
      if ($reader.ReadUInt32() -ne 0x02014b50) { throw 'A ZIP central-directory entry signature is invalid.' }
      $fixed = $reader.ReadBytes(42)
      if ($fixed.Length -ne 42) { throw 'A ZIP central-directory entry is truncated.' }
      $flags = [BitConverter]::ToUInt16($fixed, 4)
      $method = [BitConverter]::ToUInt16($fixed, 6)
      $crc = [BitConverter]::ToUInt32($fixed, 12)
      $compressed = [BitConverter]::ToUInt32($fixed, 16)
      $uncompressed = [BitConverter]::ToUInt32($fixed, 20)
      $nameLength = [BitConverter]::ToUInt16($fixed, 24)
      $extraLength = [BitConverter]::ToUInt16($fixed, 26)
      $commentLength = [BitConverter]::ToUInt16($fixed, 28)
      $diskStart = [BitConverter]::ToUInt16($fixed, 30)
      $externalAttributes = [BitConverter]::ToUInt32($fixed, 34)
      $entryNameBytes = $reader.ReadBytes($nameLength)
      $extra = $reader.ReadBytes($extraLength)
      $comment = $reader.ReadBytes($commentLength)
      if ($entryNameBytes.Length -ne $nameLength -or $extra.Length -ne $extraLength -or $comment.Length -ne $commentLength -or
          $diskStart -ne 0 -or $compressed -eq 0xFFFFFFFF -or $uncompressed -eq 0xFFFFFFFF -or
          ($flags -band 0x1) -ne 0 -or ($method -ne 0 -and $method -ne 8)) {
        throw 'A ZIP entry is encrypted, unsupported, or uses ZIP64 metadata.'
      }
      $extraOffset = 0
      while ($extraOffset -lt $extra.Length) {
        if ($extra.Length - $extraOffset -lt 4) { throw 'A ZIP entry has malformed extra metadata.' }
        $extraId = [BitConverter]::ToUInt16($extra, $extraOffset)
        $extraSize = [BitConverter]::ToUInt16($extra, $extraOffset + 2)
        if ($extraOffset + 4 + $extraSize -gt $extra.Length) { throw 'A ZIP entry has truncated extra metadata.' }
        if ($extraId -eq 0x0001) { throw 'ZIP64 entries are not accepted by this bounded preflight.' }
        $extraOffset += 4 + $extraSize
      }
      [void]$central.Add([pscustomobject]@{
        Crc32 = [uint32]$crc
        CompressedBytes = [long]$compressed
        UncompressedBytes = [long]$uncompressed
        Method = [int]$method
        ExternalAttributes = [long]$externalAttributes
      })
    }
    if ($stream.Position -ne [long]$directoryOffset + [long]$directorySize) {
      throw 'A ZIP central directory has unexpected trailing records.'
    }
    return @($central)
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Assert-ZipArchiveSafe(
  [string] $ArchivePath,
  [long] $MaxTotalBytes = $script:MaxZipTotalBytes,
  [long] $MaxEntryBytes = $script:MaxZipEntryBytes
) {
  Add-PreflightCrcType
  $archiveInfo = Get-Item -LiteralPath $ArchivePath -ErrorAction Stop
  if ($archiveInfo.Length -le 0 -or $archiveInfo.Length -gt $MaxTotalBytes) {
    throw 'A ZIP archive is empty or exceeds the configured compressed-size limit.'
  }
  Add-Type -AssemblyName System.IO.Compression
  $fileStream = [IO.File]::OpenRead($ArchivePath)
  $archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt $script:MaxZipEntries) {
      throw 'A ZIP archive has no entries or exceeds the entry-count limit.'
    }
    $central = @(Read-ZipCentralDirectory $ArchivePath $archive.Entries.Count)
    if ($central.Count -ne $archive.Entries.Count) { throw 'ZIP central-directory count differs from parsed entries.' }
    $spellings = @{}
    $nodeTypes = @{}
    $explicit = @{}
    $totalBytes = [long]0
    $summaries = New-Object System.Collections.ArrayList
    for ($index = 0; $index -lt $archive.Entries.Count; $index++) {
      $entry = $archive.Entries[$index]
      $directory = $entry.FullName.EndsWith('/')
      $relative = Get-ZipEntryPath $entry.FullName $directory
      $entryMeta = $central[$index]
      $actualExternalAttributes = ([long]$entry.ExternalAttributes -band 0xFFFFFFFFL)
      if ([long]$entry.Length -ne $entryMeta.UncompressedBytes -or
          [long]$entry.CompressedLength -ne $entryMeta.CompressedBytes -or
          $actualExternalAttributes -ne $entryMeta.ExternalAttributes) {
        throw 'ZIP central-directory metadata does not match the decoded entry.'
      }
      if ($entry.Length -gt $MaxEntryBytes) { throw 'A ZIP entry exceeds the per-entry size limit.' }
      $totalBytes += [long]$entry.Length
      if ($totalBytes -gt $MaxTotalBytes) { throw 'A ZIP archive exceeds the total uncompressed-size limit.' }
      $unixType = ($entryMeta.ExternalAttributes -shr 16) -band 0xF000
      $dosAttributes = $entryMeta.ExternalAttributes -band 0xFFFF
      if ($unixType -eq 0xA000 -or ($dosAttributes -band 0x400) -ne 0 -or
          ($unixType -ne 0 -and $unixType -ne 0x8000 -and $unixType -ne 0x4000)) {
        throw 'A ZIP entry is a link, reparse point, or unsupported special file.'
      }
      if ($directory -and $entry.Length -ne 0) { throw 'A ZIP directory entry contains data.' }

      $segments = $relative.Split('/')
      $prefix = ''
      for ($segmentIndex = 0; $segmentIndex -lt $segments.Length; $segmentIndex++) {
        $prefix = if ($prefix.Length -eq 0) { $segments[$segmentIndex] } else { "$prefix/$($segments[$segmentIndex])" }
        $last = $segmentIndex -eq $segments.Length - 1
        $expectedType = if ($last -and -not $directory) { 'file' } else { 'directory' }
        if ($spellings.ContainsKey($prefix)) {
          if (-not [string]::Equals([string]$spellings[$prefix], $prefix, [StringComparison]::Ordinal)) {
            throw 'ZIP entries contain a case-folded path collision.'
          }
        } else {
          $spellings[$prefix] = $prefix
        }
        if ($nodeTypes.ContainsKey($prefix)) {
          if (-not $last -and $nodeTypes[$prefix] -ne 'directory') { throw 'A ZIP file is used as a parent directory.' }
          if ($last -and $expectedType -ne $nodeTypes[$prefix]) { throw 'A ZIP file and directory collide at one path.' }
        } else {
          $nodeTypes[$prefix] = $expectedType
        }
      }
      if ($explicit.ContainsKey($relative)) { throw 'A ZIP archive repeats a path, including case-only duplicates.' }
      $explicit[$relative] = $true
      if (-not $directory -and @($spellings.Keys | Where-Object { $_.StartsWith("$relative/", [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        throw 'A ZIP file conflicts with an existing child path.'
      }

      $content = $entry.Open()
      try { $crc = [MorrowPreflightCrc]::Compute($content) }
      finally { $content.Dispose() }
      if ($crc -ne [uint32]$entryMeta.Crc32) { throw "ZIP CRC mismatch for $relative." }
      [void]$summaries.Add([pscustomobject]@{
        path = $relative
        isDirectory = $directory
        sizeBytes = [long]$entry.Length
      })
    }
    return [pscustomobject]@{
      EntryCount = $archive.Entries.Count
      TotalUncompressedBytes = $totalBytes
      Entries = @($summaries)
    }
  } finally {
    $archive.Dispose()
  }
}

function Expand-SafeZipArchive(
  [string] $ArchivePath,
  [string] $DestinationPath,
  [long] $MaxTotalBytes = $script:MaxZipTotalBytes,
  [long] $MaxEntryBytes = $script:MaxZipEntryBytes
) {
  $validation = Assert-ZipArchiveSafe $ArchivePath $MaxTotalBytes $MaxEntryBytes
  $destination = Assert-NoPathCollision $DestinationPath 'ZIP extraction destination'
  $root = [IO.Directory]::CreateDirectory($destination).FullName.TrimEnd('\')
  Assert-NoReparsePath $root 'ZIP extraction root' | Out-Null
  $fileStream = [IO.File]::OpenRead($ArchivePath)
  $archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    foreach ($entry in $archive.Entries) {
      $directory = $entry.FullName.EndsWith('/')
      $relative = Get-ZipEntryPath $entry.FullName $directory
      $nativeRelative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $nativeRelative))
      $prefix = $root.TrimEnd('\') + '\'
      if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A ZIP extraction target escaped its new tool-stage directory.'
      }
      if ($target.Length -gt 240) { throw 'A ZIP extraction target exceeds the local path limit.' }
      if ($directory) {
        [void][IO.Directory]::CreateDirectory($target)
        Assert-NoReparsePath $target 'ZIP extraction directory' | Out-Null
        continue
      }
      $parent = [IO.Path]::GetDirectoryName($target)
      [void][IO.Directory]::CreateDirectory($parent)
      Assert-NoReparsePath $parent 'ZIP extraction parent' | Out-Null
      $inputStream = $entry.Open()
      $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $inputStream.CopyTo($outputStream) }
      finally { $outputStream.Dispose(); $inputStream.Dispose() }
      Assert-NoReparsePath $target 'ZIP extracted file' | Out-Null
      if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw 'An extracted ZIP entry has an unexpected byte length.' }
    }
  } finally {
    $archive.Dispose()
  }
  return $validation
}

function Get-PreflightPaths([string] $RunnerTemp, [string] $RunId, [string] $RunAttempt, [string] $SourceSha) {
  $temp = Assert-NoReparsePath $RunnerTemp 'RUNNER_TEMP'
  if (-not [IO.Directory]::Exists($temp)) { throw 'RUNNER_TEMP must already exist.' }
  $toolStage = Join-Path $temp "issue-179-tools-$RunId-$RunAttempt"
  $control = Join-Path $temp "issue-179-control-$RunId-$RunAttempt"
  $plannedRoot = Join-Path $temp "morrow-issue-179-$SourceSha-$RunId-$RunAttempt"
  $paths = [ordered]@{
    ToolStage = Assert-LocalNormalizedPath $toolStage 'Tool/download stage'
    Control = Assert-NoReparsePath $control 'Control receipt directory'
    PlannedRoot = Assert-NoPathCollision $plannedRoot 'Planned synthetic root'
    Case = Join-Path $plannedRoot 'case'
    Vault = Join-Path $plannedRoot 'vault'
    Profile = Join-Path $plannedRoot 'profile'
    Evidence = Join-Path $plannedRoot 'evidence'
    Retained = Join-Path $plannedRoot 'retained'
    MorrowUserData = Join-Path (Join-Path $plannedRoot 'profile') 'MorrowUserData'
    WebView2UserData = Join-Path (Join-Path $plannedRoot 'profile') 'WebView2UserData'
  }
  $plannedSiblings = @('case', 'vault', 'profile', 'evidence', 'retained')
  for ($left = 0; $left -lt $plannedSiblings.Count; $left++) {
    for ($right = $left + 1; $right -lt $plannedSiblings.Count; $right++) {
      if ($plannedSiblings[$left].Equals($plannedSiblings[$right], [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Planned synthetic sibling paths collide after case normalization.'
      }
    }
  }
  if ($paths.ToolStage.StartsWith($paths.PlannedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $paths.Control.StartsWith($paths.PlannedRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $paths.ToolStage.StartsWith($paths.Control, [StringComparison]::OrdinalIgnoreCase) -or
      $paths.Control.StartsWith($paths.ToolStage, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Tool-stage/control paths overlap planned synthetic outputs or each other.'
  }
  foreach ($key in @('ToolStage', 'Control', 'PlannedRoot', 'Case', 'Vault', 'Profile', 'Evidence', 'Retained', 'MorrowUserData', 'WebView2UserData')) {
    $paths[$key] = Assert-LocalNormalizedPath ([string]$paths[$key]) "Planned $key path"
  }
  return [pscustomobject]$paths
}

function Add-KnownFolderType {
  if ('MorrowKnownFolder' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MorrowKnownFolder
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHGetKnownFolderPath(
        [MarshalAs(UnmanagedType.LPStruct)] Guid rfid,
        uint dwFlags,
        IntPtr hToken,
        out IntPtr ppszPath);

    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr ptr);

    public static string Get(string folderId)
    {
        IntPtr path = IntPtr.Zero;
        int result = SHGetKnownFolderPath(new Guid(folderId), 0, IntPtr.Zero, out path);
        if (result < 0) Marshal.ThrowExceptionForHR(result);
        try { return Marshal.PtrToStringUni(path); }
        finally { if (path != IntPtr.Zero) CoTaskMemFree(path); }
    }
}
'@
}

function Get-WindowsKnownFolderPaths {
  Add-KnownFolderType
  $local = [MorrowKnownFolder]::Get('F1B32785-6FBA-4FCF-9D55-7B8E7F157091')
  $roaming = [MorrowKnownFolder]::Get('3EB685DB-65F9-4CF6-A03A-E3EF65729F3D')
  $local = Assert-NoReparsePath $local 'KnownFolder LocalAppData'
  $roaming = Assert-NoReparsePath $roaming 'KnownFolder RoamingAppData'
  if (-not [IO.Directory]::Exists($local) -or -not [IO.Directory]::Exists($roaming)) {
    throw 'SHGetKnownFolderPath returned a missing LocalAppData or RoamingAppData directory.'
  }
  return [pscustomobject]@{ LocalAppData = $local; RoamingAppData = $roaming }
}

function Get-WebView2RegistryValue([Microsoft.Win32.RegistryHive] $Hive, [string] $KeyPath) {
  $hiveLabel = if ($Hive -eq [Microsoft.Win32.RegistryHive]::LocalMachine) { 'HKLM64' } else { 'HKCU64' }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.OpenSubKey($KeyPath, $false)
    if ($null -eq $key) {
      return [pscustomobject]@{ Present = $false; Value = $null; Kind = $null; RegistryPath = "$hiveLabel\$KeyPath" }
    }
    try {
      $value = $key.GetValue('pv', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = if ($key.GetValueKind('pv') -eq [Microsoft.Win32.RegistryValueKind]::String) { 'REG_SZ' } else { 'OTHER' }
      return [pscustomobject]@{ Present = $true; Value = $value; Kind = $kind; RegistryPath = "$hiveLabel\$KeyPath" }
    } catch [System.ArgumentException] {
      return [pscustomobject]@{ Present = $true; Value = $null; Kind = 'MISSING_PV'; RegistryPath = "$hiveLabel\$KeyPath" }
    } finally {
      $key.Dispose()
    }
  } finally {
    $base.Dispose()
  }
}

function Select-WebView2RuntimeVersion([object[]] $Candidates) {
  $present = @($Candidates | Where-Object { $_.Present })
  if ($present.Count -eq 0) { throw 'WebView2 Evergreen Runtime pv was not found in the documented 64-bit registry locations.' }
  $versions = New-Object System.Collections.ArrayList
  foreach ($candidate in $present) {
    if ($candidate.Kind -ne 'REG_SZ' -or [string]$candidate.Value -notmatch '^\d+\.\d+\.\d+\.\d+$') {
      throw 'A present WebView2 registry key has a missing, non-string, or malformed pv value.'
    }
    try { $version = [version]([string]$candidate.Value) }
    catch { throw 'A present WebView2 registry key has an invalid pv version.' }
    if ($version -le [version]'0.0.0.0') { throw 'A present WebView2 registry key has a zero pv version.' }
    [void]$versions.Add([pscustomobject]@{
      RegistryPath = [string]$candidate.RegistryPath
      Version = [string]$candidate.Value
      MajorMinorBuild = ($version.Major.ToString() + '.' + $version.Minor + '.' + $version.Build)
    })
  }
  $unique = @($versions | Select-Object -ExpandProperty Version -Unique)
  if ($unique.Count -ne 1) { throw 'The machine/user WebView2 pv values disagree; preflight refuses ambiguous runtime selection.' }
  return [pscustomobject]@{ Version = [string]$unique[0]; Sources = @($versions) }
}

function Get-WebView2Runtime {
  if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    throw 'This preflight requires a 64-bit Windows process and operating system.'
  }
  $machinePath = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + $script:WebView2ClientGuid
  $userPath = 'Software\Microsoft\EdgeUpdate\Clients\' + $script:WebView2ClientGuid
  $candidates = @(
    (Get-WebView2RegistryValue ([Microsoft.Win32.RegistryHive]::LocalMachine) $machinePath),
    (Get-WebView2RegistryValue ([Microsoft.Win32.RegistryHive]::CurrentUser) $userPath)
  )
  return (Select-WebView2RuntimeVersion $candidates)
}

function Get-CurrentWindowsIdentity {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    if ($null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.User.Value)) {
      throw 'Windows identity has no SID.'
    }
    return [pscustomobject]@{ Sid = $identity.User.Value; Account = [string]$identity.Name }
  } finally {
    $identity.Dispose()
  }
}

function Assert-NoKnownFolderPilotCollision([string] $Parent, [string] $Identifier, [string] $Label) {
  $target = Join-Path $Parent $Identifier
  Assert-LocalNormalizedPath $target $Label | Out-Null
  if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) {
    throw "$Label already exists; existing Windows profile metadata is preserved."
  }
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Parent)) {
    if ([string]::Equals([IO.Path]::GetFileName($entry), $Identifier, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label has a case-insensitive collision; existing Windows profile metadata is preserved."
    }
  }
  return $target
}

function Get-SanitizedPath([string] $Path) {
  $safe = $Path
  if (-not [string]::IsNullOrEmpty($env:USERPROFILE)) { $safe = $safe.Replace($env:USERPROFILE, '%USERPROFILE%') }
  if (-not [string]::IsNullOrEmpty($env:RUNNER_TEMP)) { $safe = $safe.Replace($env:RUNNER_TEMP, '%RUNNER_TEMP%') }
  return $safe
}

function Invoke-CapturedCommand(
  [string] $Executable,
  [string[]] $Arguments,
  [string] $WorkingDirectory,
  [string] $LogPath,
  [int] $TimeoutSeconds = 5400,
  [switch] $VersionProbe
) {
  Assert-SafeDriverInvocation $Executable $Arguments
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
  foreach ($name in @('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'SYSTEM_ACCESSTOKEN')) {
    [void]$startInfo.EnvironmentVariables.Remove($name)
  }
  if ($VersionProbe -and [IO.Path]::GetFileName($Executable) -ieq 'msedgedriver.exe') {
    $startInfo.EnvironmentVariables['MSEDGEDRIVER_TELEMETRY_OPTOUT'] = '1'
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'A preflight child process could not be started.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill($true) } catch {}
    $process.Dispose()
    throw 'A preflight tool command exceeded its timeout and was stopped.'
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  $process.Dispose()
  $safeOutput = Protect-Text(($stdout + [Environment]::NewLine + $stderr).Trim())
  if ($safeOutput.Length -gt 2MB) { $safeOutput = $safeOutput.Substring(0, 2MB) + [Environment]::NewLine + '[truncated]' }
  [IO.File]::WriteAllText($LogPath, $safeOutput, [Text.UTF8Encoding]::new($false))
  $processResult = [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = Protect-Text($stdout.Trim())
    StdErr = Protect-Text($stderr.Trim())
    Log = [IO.Path]::GetFileName($LogPath)
  }
  if ($processResult.ExitCode -ne 0) { throw "A preflight command failed with exit code $($processResult.ExitCode); see its sanitized control log." }
  return $processResult
}

function Get-VersionFromOutput([string] $Output, [string] $Label) {
  $match = [regex]::Match($Output, '(?<!\d)(\d+\.\d+\.\d+\.\d+|\d+\.\d+\.\d+)(?!\d)')
  if (-not $match.Success) { throw "$Label --version output contained no semantic version." }
  return $match.Groups[1].Value
}

function Get-CargoInstalledPackageVersion([string] $Output, [string] $Package, [string] $ExpectedVersion) {
  $packageName = [regex]::Escape($Package)
  $headers = [regex]::Matches($Output, "(?m)^$packageName v(?<version>\d+\.\d+\.\d+):[ \t]*\r?$")
  if ($headers.Count -ne 1) { throw "cargo install --list did not report exactly one $Package package entry." }
  $version = $headers[0].Groups['version'].Value
  if ($version -ne $ExpectedVersion) { throw "cargo install --list reported $Package $version; expected exactly $ExpectedVersion." }
  $binaryPattern = "(?m)^[ \t]+$packageName(?:\.exe)?[ \t]*\r?$"
  if (-not [regex]::IsMatch($Output, $binaryPattern)) {
    throw "cargo install --list did not list the expected $Package binary (with or without the Windows .exe suffix)."
  }
  return $version
}

function Assert-OfficialMicrosoftUrl([string] $Url, [string] $ExpectedPath) {
  if ([string]::IsNullOrWhiteSpace($Url)) { throw 'An official Microsoft EdgeDriver URL is empty.' }
  try { $uri = [Uri]::new($Url, [UriKind]::Absolute) }
  catch { throw 'An official Microsoft EdgeDriver URL is malformed.' }
  if ($uri.Scheme -cne 'https' -or $uri.DnsSafeHost -cne 'msedgedriver.microsoft.com' -or
      $uri.Port -ne 443 -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or
      -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or
      $uri.AbsolutePath -cnotmatch $ExpectedPath) {
    throw 'The EdgeDriver request or response is outside the exact official Microsoft HTTPS origin and path allowlist.'
  }
  return $uri
}

function Invoke-OfficialMicrosoftGet([string] $Url, [string] $ExpectedPath, [long] $MaxBytes, [string[]] $AllowedContentTypes) {
  $requestUri = Assert-OfficialMicrosoftUrl $Url $ExpectedPath
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(30)
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $requestUri)
  [void]$request.Headers.TryAddWithoutValidation('Accept', ($AllowedContentTypes -join ', '))
  $response = $null
  $bodyStream = $null
  $memory = $null
  $timeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
  try {
    try {
      $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $timeout.Token).GetAwaiter().GetResult()
    } catch {
      throw 'The official Microsoft EdgeDriver request failed before a complete response was received.'
    }
    $responseUri = [string]$response.RequestMessage.RequestUri.AbsoluteUri
    $statusCode = [int]$response.StatusCode
    $contentType = if ($null -ne $response.Content.Headers.ContentType) { [string]$response.Content.Headers.ContentType.MediaType } else { '' }
    $declaredLength = $response.Content.Headers.ContentLength
    if ($responseUri -cne $requestUri.AbsoluteUri) { throw 'The official Microsoft EdgeDriver request changed origin or URL.' }
    if ($statusCode -ge 300 -and $statusCode -lt 400) { throw 'The official Microsoft EdgeDriver endpoint redirected; redirects are not followed.' }
    if ($statusCode -ne 200) { throw "The official Microsoft EdgeDriver endpoint returned HTTP $statusCode." }
    if ($AllowedContentTypes -cnotcontains $contentType) { throw 'The official Microsoft EdgeDriver endpoint returned an unexpected content type.' }
    if ($null -ne $declaredLength -and ($declaredLength -le 0 -or $declaredLength -gt $MaxBytes)) {
      throw 'The official Microsoft EdgeDriver response is empty or exceeds its byte limit.'
    }

    $bodyStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $memory = [IO.MemoryStream]::new()
    $buffer = New-Object byte[] 65536
    $totalBytes = 0L
    while (($read = $bodyStream.ReadAsync($buffer, 0, $buffer.Length, $timeout.Token).GetAwaiter().GetResult()) -gt 0) {
      $totalBytes += $read
      if ($totalBytes -gt $MaxBytes) { throw 'The official Microsoft EdgeDriver response exceeded its byte limit while streaming.' }
      $memory.Write($buffer, 0, $read)
    }
    if ($totalBytes -le 0 -or ($null -ne $declaredLength -and $totalBytes -ne [long]$declaredLength)) {
      throw 'The official Microsoft EdgeDriver response is empty or has a mismatched content length.'
    }
    return [pscustomobject]@{
      RequestUrl = $requestUri.AbsoluteUri
      ResponseUrl = $responseUri
      StatusCode = $statusCode
      ContentType = $contentType
      DeclaredContentLength = if ($null -eq $declaredLength) { $null } else { [long]$declaredLength }
      ContentBytes = $memory.ToArray()
    }
  } finally {
    if ($null -ne $memory) { $memory.Dispose() }
    if ($null -ne $bodyStream) { $bodyStream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    $timeout.Dispose()
    $request.Dispose()
    $client.Dispose()
    $handler.Dispose()
  }
}

function ConvertFrom-OfficialCatalogJsonElement([object] $Element) {
  switch ([string]$Element.ValueKind) {
    'Object' {
      $value = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
      foreach ($property in $Element.EnumerateObject()) {
        if ($value.ContainsKey($property.Name)) { throw 'The official Microsoft EdgeDriver catalog contains a duplicate JSON property.' }
        $value.Add($property.Name, (ConvertFrom-OfficialCatalogJsonElement $property.Value))
      }
      return ,$value
    }
    'Array' {
      $value = [Collections.ArrayList]::new()
      foreach ($entry in $Element.EnumerateArray()) {
        [void]$value.Add((ConvertFrom-OfficialCatalogJsonElement $entry))
      }
      return ,$value
    }
    'String' { return $Element.GetString() }
    'Number' {
      $integer = 0L
      if (-not $Element.TryGetInt64([ref]$integer)) { throw 'The official Microsoft EdgeDriver catalog contains a non-integer JSON number.' }
      return $integer
    }
    'True' { return $true }
    'False' { return $false }
    'Null' { return $null }
    default { throw 'The official Microsoft EdgeDriver catalog contains an unsupported JSON value.' }
  }
}

function ConvertFrom-OfficialCatalogJson([string] $Json, [switch] $ForceJsonDom) {
  $convertFromJson = Get-Command ConvertFrom-Json -ErrorAction Stop
  if (-not $ForceJsonDom -and $convertFromJson.Parameters.ContainsKey('DateKind')) {
    return (ConvertFrom-Json -InputObject $Json -AsHashtable -NoEnumerate -DateKind String -ErrorAction Stop)
  }
  Add-Type -AssemblyName System.Text.Json -ErrorAction Stop
  $document = [System.Text.Json.JsonDocument]::Parse($Json)
  try { return ,(ConvertFrom-OfficialCatalogJsonElement $document.RootElement) }
  finally { $document.Dispose() }
}

function Convert-OfficialEdgeDriverCatalog(
  [string] $RequestUrl,
  [string] $ResponseUrl,
  [int] $StatusCode,
  [string] $ContentType,
  [byte[]] $ContentBytes,
  [object] $DeclaredContentLength
) {
  $requestUri = Assert-OfficialMicrosoftUrl $RequestUrl '^/listing\.json$'
  $responseUri = Assert-OfficialMicrosoftUrl $ResponseUrl '^/listing\.json$'
  if ($requestUri.AbsoluteUri -cne $responseUri.AbsoluteUri) { throw 'The official Microsoft EdgeDriver catalog response changed URL or origin.' }
  if ($StatusCode -ge 300 -and $StatusCode -lt 400) { throw 'The official Microsoft EdgeDriver catalog redirected; redirects are rejected.' }
  if ($StatusCode -ne 200) { throw "The official Microsoft EdgeDriver catalog returned HTTP $StatusCode." }
  if ($ContentType -cne 'application/json') { throw 'The official Microsoft EdgeDriver catalog content type is not application/json.' }
  if ($null -eq $ContentBytes -or $ContentBytes.Length -le 0 -or $ContentBytes.Length -gt $script:MaxOfficialCatalogBytes) {
    throw 'The official Microsoft EdgeDriver catalog is empty or exceeds its byte limit.'
  }
  if ($null -ne $DeclaredContentLength -and
      ([long]$DeclaredContentLength -le 0 -or [long]$DeclaredContentLength -ne $ContentBytes.Length)) {
    throw 'The official Microsoft EdgeDriver catalog has a mismatched content length.'
  }

  try { $json = [Text.UTF8Encoding]::new($false, $true).GetString($ContentBytes) }
  catch { throw 'The official Microsoft EdgeDriver catalog is not valid UTF-8.' }
  try { $catalog = ConvertFrom-OfficialCatalogJson $json }
  catch { throw 'The official Microsoft EdgeDriver catalog is malformed JSON.' }
  if ($catalog -isnot [Collections.IDictionary]) { throw 'The official Microsoft EdgeDriver catalog root is not an object.' }
  $catalogKeys = @($catalog.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
  if ($catalogKeys.Count -ne 2 -or $catalogKeys[0] -cne 'generatedAt' -or $catalogKeys[1] -cne 'items') {
    throw 'The official Microsoft EdgeDriver catalog has an unexpected top-level schema.'
  }
  if ($catalog['generatedAt'] -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$catalog['generatedAt'])) {
    throw 'The official Microsoft EdgeDriver catalog has no generatedAt timestamp.'
  }
  try { $generatedAt = [DateTimeOffset]::Parse([string]$catalog['generatedAt'], [Globalization.CultureInfo]::InvariantCulture) }
  catch { throw 'The official Microsoft EdgeDriver catalog generatedAt timestamp is malformed.' }
  $itemsValue = $catalog['items']
  if ($itemsValue -isnot [Collections.IList] -or $itemsValue -is [string]) {
    throw 'The official Microsoft EdgeDriver catalog items field is not an array.'
  }
  $items = @($itemsValue)
  if ($items.Count -le 0 -or $items.Count -gt $script:MaxOfficialCatalogItems) {
    throw 'The official Microsoft EdgeDriver catalog item count is empty or exceeds its limit.'
  }

  $seenNames = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
  $normalized = New-Object System.Collections.ArrayList
  foreach ($item in $items) {
    if ($item -isnot [Collections.IDictionary]) { throw 'The official Microsoft EdgeDriver catalog contains a non-object item.' }
    $itemKeys = @($item.Keys | ForEach-Object { [string]$_ } | Sort-Object -CaseSensitive)
    if ($itemKeys.Count -ne 4 -or $itemKeys[0] -cne 'contentLength' -or $itemKeys[1] -cne 'isDirectory' -or
        $itemKeys[2] -cne 'lastModified' -or $itemKeys[3] -cne 'name') {
      throw 'The official Microsoft EdgeDriver catalog contains an unexpected item schema.'
    }
    if ($item['isDirectory'] -isnot [bool]) { throw 'The official Microsoft EdgeDriver catalog item has an invalid isDirectory value.' }
    $rawLength = $item['contentLength']
    if ($rawLength -isnot [int] -and $rawLength -isnot [long]) { throw 'The official Microsoft EdgeDriver catalog item has a non-integer contentLength.' }
    $contentLength = [long]$rawLength
    if ($contentLength -lt 0) { throw 'The official Microsoft EdgeDriver catalog item has a negative contentLength.' }
    if ($item['lastModified'] -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$item['lastModified'])) {
      throw 'The official Microsoft EdgeDriver catalog item has no lastModified timestamp.'
    }
    try { $lastModified = [DateTimeOffset]::Parse([string]$item['lastModified'], [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw 'The official Microsoft EdgeDriver catalog item has a malformed lastModified timestamp.' }
    if ($item['name'] -isnot [string]) { throw 'The official Microsoft EdgeDriver catalog item name is not text.' }
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
      try { $parsedVersion = [version]$versionText }
      catch { throw 'The official Microsoft EdgeDriver catalog contains an invalid driver version path.' }
    } elseif ($name -cmatch '^wpt-mojom/\d+\.\d+\.\d+\.\d+/linux64/mojojs\.zip$') {
      $kind = 'wptArchive'
    } elseif ($name -cmatch '^LATEST_(?:BETA|CANARY|DEV|EXTENDEDSTABLE|STABLE|RELEASE_\d+(?:_(?:LINUX|MACOS|WINDOWS))?)$') {
      $kind = 'versionAlias'
    } elseif ($name -cin @('EMPTY', 'EULA', 'credits.html', 'listing.json')) {
      $kind = 'catalogMetadata'
    } else {
      throw 'The official Microsoft EdgeDriver catalog contains an unknown or malformed item name.'
    }
    if ($item['isDirectory'] -or $contentLength -le 0) {
      throw 'The official Microsoft EdgeDriver catalog item is not a non-empty file.'
    }
    $signature = ([string]$item['isDirectory']) + '|' + $contentLength + '|' + [string]$item['lastModified']
    if ($seenNames.ContainsKey($name)) {
      $prior = $seenNames[$name]
      if ($prior.Name -cne $name -or $prior.Signature -cne $signature) {
        throw 'The official Microsoft EdgeDriver catalog repeats a name with conflicting metadata.'
      }
      continue
    }
    $seenNames.Add($name, [pscustomobject]@{ Name = $name; Signature = $signature })
    [void]$normalized.Add([pscustomobject]@{
      Name = $name
      Kind = $kind
      FileName = $fileName
      Version = $versionText
      ParsedVersion = $parsedVersion
      IsDirectory = [bool]$item['isDirectory']
      ContentLength = $contentLength
      LastModified = $lastModified.ToString('o')
    })
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $catalogSha256 = ([BitConverter]::ToString($sha.ComputeHash($ContentBytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [pscustomobject]@{
    GeneratedAt = $generatedAt.ToString('o')
    Items = @($normalized)
    ItemCount = $items.Count
    SizeBytes = $ContentBytes.Length
    Sha256 = $catalogSha256
    SourceUrl = $requestUri.AbsoluteUri
  }
}

function Select-OfficialEdgeDriverRelease([string] $RuntimeVersion, [object] $Catalog) {
  if ([string]$RuntimeVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'The observed WebView2 pv is not a four-component version.' }
  try { $runtimeParsed = [version]$RuntimeVersion }
  catch { throw 'The observed WebView2 pv is not a valid version.' }
  $runtimeBuild = $runtimeParsed.Major.ToString() + '.' + $runtimeParsed.Minor + '.' + $runtimeParsed.Build
  $candidates = @($Catalog.Items | Where-Object {
    $_.Kind -ceq 'driverArchive' -and $_.FileName -ceq 'edgedriver_win64.zip' -and
    $null -ne $_.ParsedVersion -and
    ($_.ParsedVersion.Major.ToString() + '.' + $_.ParsedVersion.Minor + '.' + $_.ParsedVersion.Build) -ceq $runtimeBuild
  })
  if ($candidates.Count -eq 0) {
    throw 'The official Microsoft EdgeDriver catalog has no x64 driver matching the observed WebView2 pv first three components.'
  }
  $selected = @($candidates | Sort-Object -Property ParsedVersion -Descending)[0]
  if ($selected.ContentLength -gt $script:MaxOfficialDriverBytes) {
    throw 'The selected official Microsoft EdgeDriver archive exceeds its download byte limit.'
  }
  return [pscustomobject]@{
    Version = [string]$selected.Version
    Url = 'https://msedgedriver.microsoft.com/' + $selected.Version + '/edgedriver_win64.zip'
    RuntimeVersion = $RuntimeVersion
    CompatibleFirstThreeComponents = $runtimeBuild
    ExpectedArchiveBytes = [long]$selected.ContentLength
    SelectedLastModified = [string]$selected.LastModified
    SourcePage = $script:OfficialEdgeDriverPageUrl
    SourceCatalogUrl = [string]$Catalog.SourceUrl
    CatalogGeneratedAt = [string]$Catalog.GeneratedAt
    CatalogSizeBytes = [long]$Catalog.SizeBytes
    CatalogSha256 = [string]$Catalog.Sha256
    CatalogItemCount = [int]$Catalog.ItemCount
    CompatibleCandidateCount = $candidates.Count
  }
}

function Get-OfficialEdgeDriverRelease([string] $RuntimeVersion) {
  $response = Invoke-OfficialMicrosoftGet $script:OfficialEdgeDriverCatalogUrl '^/listing\.json$' $script:MaxOfficialCatalogBytes @('application/json')
  $catalog = Convert-OfficialEdgeDriverCatalog $response.RequestUrl $response.ResponseUrl $response.StatusCode `
    $response.ContentType $response.ContentBytes $response.DeclaredContentLength
  return (Select-OfficialEdgeDriverRelease $RuntimeVersion $catalog)
}

function Save-OfficialEdgeDriverArchive([object] $Release, [string] $Destination) {
  if ($Release.SourceCatalogUrl -cne $script:OfficialEdgeDriverCatalogUrl -or
      $Release.ExpectedArchiveBytes -le 0 -or $Release.ExpectedArchiveBytes -gt $script:MaxOfficialDriverBytes) {
    throw 'The selected EdgeDriver release has invalid official provenance or an unsafe archive size.'
  }
  $pathPattern = '^/' + [regex]::Escape([string]$Release.Version) + '/edgedriver_win64\.zip$'
  $response = Invoke-OfficialMicrosoftGet ([string]$Release.Url) $pathPattern $script:MaxOfficialDriverBytes @(
    'application/x-zip-compressed', 'application/zip', 'application/octet-stream'
  )
  if ($response.ContentBytes.Length -ne [long]$Release.ExpectedArchiveBytes) {
    throw 'The downloaded Microsoft EdgeDriver archive length differs from the official catalog entry.'
  }
  if ([IO.File]::Exists($Destination) -or [IO.Directory]::Exists($Destination)) {
    throw 'The Microsoft EdgeDriver archive destination already exists; the preflight will not overwrite it.'
  }
  $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($response.ContentBytes, 0, $response.ContentBytes.Length) }
  finally { $stream.Dispose() }
  return [pscustomobject]@{
    Url = $response.RequestUrl
    ResponseUrl = $response.ResponseUrl
    ContentType = $response.ContentType
    SizeBytes = $response.ContentBytes.Length
    ExpectedSizeBytes = [long]$Release.ExpectedArchiveBytes
    Sha256 = Get-Sha256 $Destination
  }
}

function Assert-PeAndPilotResources([string] $PackageRoot, [object] $BuildInfo) {
  $exePath = Join-Path $PackageRoot 'morrow.exe'
  if ((Get-Item -LiteralPath $exePath).Length -ne [long]$script:Artifact.executableSizeBytes -or
      (Get-Sha256 $exePath) -ne $script:Artifact.executableSha256) {
    throw 'The extracted executable SHA-256 does not match the pinned Windows pilot executable.'
  }
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($exePath))
  try {
    if ($reader.BaseStream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'morrow.exe is not a valid DOS/PE executable.' }
    [void]$reader.BaseStream.Seek(0x3C, [IO.SeekOrigin]::Begin)
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or $peOffset -gt $reader.BaseStream.Length - 256) { throw 'morrow.exe has an invalid PE header offset.' }
    [void]$reader.BaseStream.Seek($peOffset, [IO.SeekOrigin]::Begin)
    $signature = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(4))
    if ($signature -ne ('PE' + [char]0 + [char]0)) { throw 'morrow.exe is missing the PE signature.' }
    $machine = $reader.ReadUInt16()
    $sections = $reader.ReadUInt16()
    [void]$reader.BaseStream.Seek($peOffset + 20, [IO.SeekOrigin]::Begin)
    $optionalSize = $reader.ReadUInt16()
    [void]$reader.ReadUInt16()
    $optionalOffset = $peOffset + 24
    if ($sections -lt 1 -or $machine -ne 0x8664 -or $optionalSize -lt 240) { throw 'morrow.exe is not an AMD64 PE32+ image.' }
    [void]$reader.BaseStream.Seek($optionalOffset, [IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt16() -ne 0x20B) { throw 'morrow.exe does not use the PE32+ optional header.' }
    [void]$reader.BaseStream.Seek($optionalOffset + 112 + 16, [IO.SeekOrigin]::Begin)
    $resourceRva = $reader.ReadUInt32()
    $resourceSize = $reader.ReadUInt32()
    if ($resourceRva -eq 0 -or $resourceSize -eq 0) { throw 'morrow.exe has no PE resource directory.' }
  } finally {
    $reader.Dispose()
  }
  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
  if ($versionInfo.ProductName -ne 'Morrow Polaris Dados Pilot' -or $versionInfo.ProductVersion -notmatch '^2\.1\.0(?:$|[.+-])') {
    throw 'The PE version resource does not identify the pinned Morrow Polaris Dados 2.1 pilot.'
  }
  if ($BuildInfo.pilotIdentifier -ne $script:Artifact.pilotIdentifier -or
      $BuildInfo.overlay.identifier -ne $script:Artifact.pilotIdentifier -or
      $BuildInfo.overlay.bundleActive -ne $false -or
      $BuildInfo.overlay.path -ne $script:Artifact.overlayPath -or
      $BuildInfo.overlay.sha256 -ne $script:Artifact.overlaySha256 -or
      $BuildInfo.overlay.mcpResourceSource -ne $script:Artifact.mcpResourceSource -or
      $BuildInfo.overlay.mcpResourceTarget -ne $script:Artifact.mcpResourceTarget -or
      $BuildInfo.template.path -ne $script:Artifact.demoVaultPath -or
      $BuildInfo.template.sha256 -ne $script:Artifact.demoVaultSha256) {
    throw 'BUILD-INFO does not identify the isolated pilot Tauri resource/identifier configuration.'
  }
  return [pscustomobject]@{
    sha256 = $script:Artifact.executableSha256
    peMachine = 'AMD64'
    peFormat = 'PE32+'
    resourceDirectoryPresent = $true
    productName = $versionInfo.ProductName
    productVersion = $versionInfo.ProductVersion
    pilotIdentifier = [string]$BuildInfo.pilotIdentifier
  }
}

function Assert-PinnedPackageInventory([string] $PackageRoot, [object] $BuildInfo) {
  $buildInfoPath = Join-Path $PackageRoot 'BUILD-INFO.json'
  $sumsPath = Join-Path $PackageRoot 'SHA256SUMS'
  if ((Get-Item -LiteralPath $buildInfoPath).Length -ne [long]$script:Artifact.buildInfoSizeBytes -or
      (Get-Sha256 $buildInfoPath) -ne $script:Artifact.buildInfoSha256) {
    throw 'The package BUILD-INFO.json size or digest differs from the exact issue 185 pin.'
  }
  if (-not [IO.File]::Exists($sumsPath) -or
      (Get-Item -LiteralPath $sumsPath).Length -ne [long]$script:Artifact.sha256SumsSizeBytes -or
      (Get-Sha256 $sumsPath) -ne $script:Artifact.sha256SumsSha256) {
    throw 'The package SHA256SUMS inventory size or digest differs from the exact issue 185 pin.'
  }

  $inventory = @($BuildInfo.fileInventory)
  if ($inventory.Count -ne [int]$script:Artifact.fileInventoryCount) { throw 'The pinned BUILD-INFO file inventory has an unexpected entry count.' }
  $expectedHashes = @{}
  $expectedHashes['BUILD-INFO.json'] = $script:Artifact.buildInfoSha256
  foreach ($entry in $inventory) {
    if ($null -eq $entry -or [string]$entry.path -ne (Get-ZipEntryPath ([string]$entry.path) $false) -or
        [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'A BUILD-INFO inventory entry has an invalid path or SHA-256.'
    }
    if ($expectedHashes.ContainsKey([string]$entry.path)) { throw 'The BUILD-INFO inventory repeats a package path.' }
    $size = 0L
    try { $size = [long]$entry.sizeBytes } catch { throw 'A BUILD-INFO inventory entry has an invalid size.' }
    if ($size -lt 0) { throw 'A BUILD-INFO inventory entry has a negative size.' }
    $expectedHashes[[string]$entry.path] = [string]$entry.sha256
  }
  if ($expectedHashes['windows-launch.ps1'] -ne $script:Artifact.launcherSha256 -or
      $expectedHashes['mcp/index.js'] -ne $script:Artifact.mcpResourceSha256 -or
      $expectedHashes['morrow.exe'] -ne $script:Artifact.executableSha256) {
    throw 'The pinned launcher, MCP resource, or executable digest differs from BUILD-INFO.'
  }

  $sumLines = @(Get-Content -LiteralPath $sumsPath -ErrorAction Stop)
  if ($sumLines.Count -ne $expectedHashes.Count) { throw 'SHA256SUMS does not list the exact pinned package inventory.' }
  $sumHashes = @{}
  foreach ($line in $sumLines) {
    if ([string]$line -notmatch '^([0-9a-f]{64})  (.+)$') { throw 'SHA256SUMS contains a malformed entry.' }
    $hash = $Matches[1]
    $path = $Matches[2]
    if ($sumHashes.ContainsKey($path)) { throw 'SHA256SUMS repeats a package path.' }
    $sumHashes[$path] = $hash
  }
  if ($sumHashes.Count -ne $expectedHashes.Count) { throw 'SHA256SUMS has ambiguous or missing package paths.' }
  foreach ($path in $expectedHashes.Keys) {
    if (-not $sumHashes.ContainsKey($path) -or $sumHashes[$path] -cne $expectedHashes[$path]) {
      throw 'SHA256SUMS does not match the pinned BUILD-INFO inventory.'
    }
  }

  $expectedFilePaths = @($expectedHashes.Keys) + @('SHA256SUMS')
  $actualFiles = @(Get-ChildItem -LiteralPath $PackageRoot -File -Force -Recurse -ErrorAction Stop)
  if ($actualFiles.Count -ne $expectedFilePaths.Count) { throw 'The extracted package file count differs from the pinned inventory.' }
  foreach ($file in $actualFiles) {
    Assert-NoReparsePath $file.FullName 'Pinned package inventory file' | Out-Null
    $relative = [IO.Path]::GetRelativePath($PackageRoot, $file.FullName).Replace('\', '/')
    if ($expectedFilePaths -cnotcontains $relative) { throw 'The extracted package contains a file outside the pinned inventory.' }
    if ($relative -eq 'SHA256SUMS') { continue }
    $expectedHash = [string]$expectedHashes[$relative]
    $expectedInventoryEntry = @($inventory | Where-Object { [string]$_.path -ceq $relative })
    $expectedSize = if ($relative -eq 'BUILD-INFO.json') { [long]$script:Artifact.buildInfoSizeBytes } else { [long]$expectedInventoryEntry[0].sizeBytes }
    if ((Get-Item -LiteralPath $file.FullName).Length -ne $expectedSize -or (Get-Sha256 $file.FullName) -cne $expectedHash) {
      throw 'An extracted package file size or SHA-256 differs from the pinned inventory.'
    }
  }
  return [pscustomobject]@{
    fileCount = $actualFiles.Count
    fileInventoryCount = $inventory.Count
    buildInfoSha256 = $script:Artifact.buildInfoSha256
    sha256SumsSha256 = $script:Artifact.sha256SumsSha256
    launcherSha256 = $script:Artifact.launcherSha256
    mcpResourceSha256 = $script:Artifact.mcpResourceSha256
  }
}

function Assert-PinnedPackage([string] $PackageRoot) {
  $buildInfoPath = Join-Path $PackageRoot 'BUILD-INFO.json'
  if (-not (Test-Path -LiteralPath $buildInfoPath -PathType Leaf)) { throw 'Extracted package has no BUILD-INFO.json.' }
  if ((Get-Item -LiteralPath $buildInfoPath).Length -ne [long]$script:Artifact.buildInfoSizeBytes -or
      (Get-Sha256 $buildInfoPath) -ne $script:Artifact.buildInfoSha256) {
    throw 'The extracted BUILD-INFO.json does not match the pinned issue 185 provenance digest.'
  }
  try { $buildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'Extracted package BUILD-INFO.json is invalid JSON.' }
  if ($buildInfo.schemaVersion -ne 1 -or $buildInfo.scope -ne 'Morrow E003-G12 issue 178' -or
      $buildInfo.sourceBuildPlatform -ne 'windows-native' -or $buildInfo.applicationVersion -ne '2.1.0' -or
      $buildInfo.appLaunched -ne $false -or $buildInfo.windowsRuntimeTested -ne $false -or
      $buildInfo.run.id -ne $script:Artifact.runId -or $buildInfo.run.attempt -ne $script:Artifact.runAttempt -or
      $buildInfo.run.sha -ne $script:Artifact.sourceSha -or $buildInfo.git.head -ne $script:Artifact.sourceSha -or
      $buildInfo.git.branch -ne 'pilot/e003-polaris-dados-2.0' -or
      $buildInfo.git.tree -ne $script:Artifact.sourceTree -or
      $buildInfo.git.status -ne 'clean' -or $buildInfo.runner.os -ne 'Windows' -or $buildInfo.runner.architecture -ne 'X64' -or
      $buildInfo.pilotIdentifier -ne $script:Artifact.pilotIdentifier) {
    throw 'BUILD-INFO does not match the pinned native Windows issue 178 artifact provenance.'
  }
  $debug = @($buildInfo.buildCommands | Where-Object { $_.label -eq 'tauri-windows-debug-build' })
  if ($debug.Count -ne 1 -or $debug[0].status -ne 'passed' -or $debug[0].exitCode -ne 0 -or
      $debug[0].command -notmatch '--debug' -or $debug[0].command -notmatch '--no-bundle' -or
      $debug[0].command -notmatch 'tauri\.pilot\.conf\.json') {
    throw 'BUILD-INFO does not prove the expected successful pilot debug build.'
  }
  $manifestPath = Join-Path $PackageRoot 'DemoVault/.morrow/plugins/polaris-dados/manifest.json'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($manifest.id -ne 'polaris-dados' -or $manifest.name -ne 'Polaris Dados') {
    throw 'The extracted Polaris Dados plugin manifest has an unexpected identifier or name.'
  }
  $inventory = Assert-PinnedPackageInventory $PackageRoot $buildInfo
  return [pscustomobject]@{
    BuildInfo = $buildInfo
    Pe = Assert-PeAndPilotResources $PackageRoot $buildInfo
    Inventory = $inventory
  }
}

function Invoke-PackageCheckOnly([string] $PackageRoot) {
  $launcher = Join-Path $PackageRoot 'windows-launch.ps1'
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Join-Path $PSHOME 'pwsh.exe')
  $startInfo.WorkingDirectory = $PackageRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-PackagePath', $PackageRoot, '-CheckOnly')) {
    [void]$startInfo.ArgumentList.Add($argument)
  }
  foreach ($name in @('GITHUB_TOKEN', 'GH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'SYSTEM_ACCESSTOKEN')) {
    [void]$startInfo.EnvironmentVariables.Remove($name)
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Could not start the PowerShell -CheckOnly host.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(60000)) {
    try { $process.Kill($true) } catch {}
    $process.Dispose()
    throw 'The extracted launcher -CheckOnly exceeded 60 seconds and was stopped.'
  }
  $stdout = Protect-Text($stdoutTask.GetAwaiter().GetResult())
  $stderr = Protect-Text($stderrTask.GetAwaiter().GetResult())
  $exitCode = $process.ExitCode
  $process.Dispose()
  $lines = @($stdout -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($exitCode -ne 0 -or $lines.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace($stderr)) {
    throw 'The exact issue 178 package launcher -CheckOnly did not return one clean JSON line with exit 0.'
  }
  try { $summary = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'The issue 178 package launcher -CheckOnly response was not valid JSON.' }
  if ($summary.status -ne 'passed' -or $summary.appLaunched -ne $false -or $summary.stateWritten -ne $false -or
      $summary.packageVerified -ne $true -or $summary.childEnvironmentConfigured -ne $true -or
      $summary.childEnvironmentPathsArePilotStateChildren -ne $true -or $summary.stateStatus -ne 'new') {
    throw 'The issue 178 package launcher -CheckOnly returned unexpected check-only flags.'
  }
  return $summary
}

function Assert-StagedLauncherMatchesZip([string] $InnerZip, [string] $PackageRoot) {
  $launcherPath = Join-Path $PackageRoot 'windows-launch.ps1'
  Assert-NoReparsePath $PackageRoot 'Extracted package root' | Out-Null
  Assert-NoReparsePath $launcherPath 'Extracted package launcher' | Out-Null
  if (-not [IO.File]::Exists($launcherPath)) { throw 'The extracted package launcher is missing.' }
  $archiveStream = [IO.File]::OpenRead($InnerZip)
  $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
  try {
    $entries = @($archive.Entries | Where-Object { $_.FullName -ceq 'windows-launch.ps1' })
    if ($entries.Count -ne 1) { throw 'The pinned inner ZIP must contain exactly one windows-launch.ps1 entry.' }
    $entryStream = $entries[0].Open()
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $expectedHash = ([BitConverter]::ToString($sha.ComputeHash($entryStream))).Replace('-', '').ToLowerInvariant() }
      finally { $sha.Dispose() }
    } finally {
      $entryStream.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
  $actualHash = Get-Sha256 $launcherPath
  if ($actualHash -ne $expectedHash) { throw 'The extracted windows-launch.ps1 differs from the verified pinned inner ZIP entry.' }
  return [pscustomobject]@{ sha256 = $actualHash; source = 'verified inner package ZIP entry' }
}

function Invoke-WebRequestToFile([string] $Url, [string] $Destination, [string] $Token) {
  $headers = @{ Accept = 'application/vnd.github+json' }
  if (-not [string]::IsNullOrWhiteSpace($Token)) { $headers.Authorization = 'Bearer ' + $Token }
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $Url -Headers $headers -OutFile $Destination -ErrorAction Stop | Out-Null
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf) -or (Get-Item -LiteralPath $Destination).Length -le 0) {
    throw 'A pinned source/driver download produced no bytes.'
  }
}

function Invoke-GitHubJson([string] $Url, [string] $Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { throw 'The read-only GitHub Actions token is unavailable.' }
  $headers = @{
    Accept = 'application/vnd.github+json'
    Authorization = 'Bearer ' + $Token
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  return Invoke-RestMethod -Uri $Url -Headers $headers -ErrorAction Stop
}

function Install-AndVerifyDrivers([string] $ToolStage, [string] $ControlPath, [string] $RuntimeVersion) {
  $driverRoot = Join-Path $ToolStage 'drivers'
  $tauriRoot = Join-Path $driverRoot 'tauri-driver'
  $edgeRoot = Join-Path $driverRoot 'msedgedriver'
  [void][IO.Directory]::CreateDirectory($driverRoot)
  [void][IO.Directory]::CreateDirectory($tauriRoot)
  $cargo = Get-Command cargo -ErrorAction Stop
  $cargoVersion = Invoke-CapturedCommand $cargo.Source @('--version') $ToolStage (Join-Path $ControlPath 'cargo-version.log') 120 -VersionProbe
  $cargoInstall = Invoke-CapturedCommand $cargo.Source @(
    'install', 'tauri-driver', '--version', $script:TauriDriver.version, '--locked', '--root', $tauriRoot
  ) $ToolStage (Join-Path $ControlPath 'tauri-driver-install.log') 5400
  $tauriDriverPath = Join-Path $tauriRoot 'bin/tauri-driver.exe'
  if (-not (Test-Path -LiteralPath $tauriDriverPath -PathType Leaf)) { throw 'Pinned tauri-driver installation did not produce tauri-driver.exe.' }
  $tauriList = Invoke-CapturedCommand $cargo.Source @('install', '--list', '--root', $tauriRoot) $ToolStage (Join-Path $ControlPath 'tauri-driver-install-list.log') 120
  $tauriVersion = Get-CargoInstalledPackageVersion ($tauriList.StdOut + [Environment]::NewLine + $tauriList.StdErr) 'tauri-driver' $script:TauriDriver.version

  $edgeDiscovery = [ordered]@{
    status = 'discovering'
    sourcePageUrl = $script:OfficialEdgeDriverPageUrl
    sourceCatalogUrl = $script:OfficialEdgeDriverCatalogUrl
    runtimeVersion = $RuntimeVersion
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  }
  Set-EdgeDriverDiscoveryReceipt $ControlPath $edgeDiscovery
  try {
    $edgeRelease = Get-OfficialEdgeDriverRelease $RuntimeVersion
  } catch {
    $edgeDiscovery.status = 'failed'
    $edgeDiscovery.failure = 'Official catalog retrieval, validation, or compatible x64 selection failed.'
    $edgeDiscovery.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Set-EdgeDriverDiscoveryReceipt $ControlPath $edgeDiscovery
    throw
  }
  $edgeDiscovery.status = 'selected'
  $edgeDiscovery.version = $edgeRelease.Version
  $edgeDiscovery.compatibleFirstThreeComponents = $edgeRelease.CompatibleFirstThreeComponents
  $edgeDiscovery.compatibleCandidateCount = $edgeRelease.CompatibleCandidateCount
  $edgeDiscovery.catalogGeneratedAt = $edgeRelease.CatalogGeneratedAt
  $edgeDiscovery.catalogSizeBytes = $edgeRelease.CatalogSizeBytes
  $edgeDiscovery.catalogSha256 = $edgeRelease.CatalogSha256
  $edgeDiscovery.catalogItemCount = $edgeRelease.CatalogItemCount
  $edgeDiscovery.selectedLastModified = $edgeRelease.SelectedLastModified
  Set-EdgeDriverDiscoveryReceipt $ControlPath $edgeDiscovery
  $runtimeMajorMinorBuild = $edgeRelease.CompatibleFirstThreeComponents
  $edgeUrl = $edgeRelease.Url
  $edgeZip = Join-Path $driverRoot 'msedgedriver.zip'
  try {
    $edgeDownload = Save-OfficialEdgeDriverArchive $edgeRelease $edgeZip
  } catch {
    $edgeDiscovery.status = 'failed'
    $edgeDiscovery.failure = 'Official x64 driver archive download or size validation failed.'
    $edgeDiscovery.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    Set-EdgeDriverDiscoveryReceipt $ControlPath $edgeDiscovery
    throw
  }
  $edgeDiscovery.status = 'downloaded'
  $edgeDiscovery.downloadUrl = $edgeDownload.Url
  $edgeDiscovery.responseUrl = $edgeDownload.ResponseUrl
  $edgeDiscovery.contentType = $edgeDownload.ContentType
  $edgeDiscovery.archiveSizeBytes = $edgeDownload.SizeBytes
  $edgeDiscovery.archiveSha256 = $edgeDownload.Sha256
  $edgeDiscovery.completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  Set-EdgeDriverDiscoveryReceipt $ControlPath $edgeDiscovery
  [void](Expand-SafeZipArchive $edgeZip $edgeRoot)
  $edgeExecutables = @(Get-ChildItem -LiteralPath $edgeRoot -Filter 'msedgedriver.exe' -File -Recurse -Force)
  if ($edgeExecutables.Count -ne 1) { throw 'The official Microsoft EdgeDriver ZIP did not contain exactly one msedgedriver.exe.' }
  $edgeDriverPath = $edgeExecutables[0].FullName
  $edgeProbe = Invoke-CapturedCommand $edgeDriverPath @('--version') $ToolStage (Join-Path $ControlPath 'msedgedriver-version.log') 30 -VersionProbe
  $edgeVersion = Get-VersionFromOutput $edgeProbe.StdOut 'msedgedriver'
  if ($edgeVersion -ne $edgeRelease.Version -or ($edgeVersion.Split('.')[0..2] -join '.') -ne $runtimeMajorMinorBuild) {
    throw 'The official Microsoft EdgeDriver probe version differs from the selected x64 download or WebView2 pv build.'
  }

  return [pscustomobject]@{
    cargo = @{ version = $cargoVersion.StdOut; executable = (Get-SanitizedPath $cargo.Source) }
    tauriDriver = @{
      version = $tauriVersion
      installedPackageMetadata = 'cargo install --list --root <tool-stage>/drivers/tauri-driver'
      installedBinaryName = 'tauri-driver.exe'
      source = 'crates.io'
      sourceUrl = $script:TauriDriver.sourceUrl
      downloadUrl = $script:TauriDriver.downloadUrl
      executablePath = Get-SanitizedPath $tauriDriverPath
      installCommand = 'cargo install tauri-driver --version 2.1.0 --locked --root <tool-stage>'
      executableSha256 = Get-Sha256 $tauriDriverPath
      serviceStarted = $false
      installListExitCode = $tauriList.ExitCode
      installExitCode = $cargoInstall.ExitCode
    }
    edgeDriver = @{
      version = $edgeVersion
      versionOutput = $edgeProbe.StdOut
      source = 'Microsoft Edge WebDriver official download'
      downloadUrl = $edgeUrl
      sourcePageUrl = $edgeRelease.SourcePage
      sourceCatalogUrl = $edgeRelease.SourceCatalogUrl
      catalogGeneratedAt = $edgeRelease.CatalogGeneratedAt
      catalogSizeBytes = $edgeRelease.CatalogSizeBytes
      catalogSha256 = $edgeRelease.CatalogSha256
      catalogItemCount = $edgeRelease.CatalogItemCount
      compatibleCandidateCount = $edgeRelease.CompatibleCandidateCount
      expectedArchiveBytes = $edgeRelease.ExpectedArchiveBytes
      selectedLastModified = $edgeRelease.SelectedLastModified
      responseUrl = $edgeDownload.ResponseUrl
      contentType = $edgeDownload.ContentType
      archiveSizeBytes = $edgeDownload.SizeBytes
      executablePath = Get-SanitizedPath $edgeDriverPath
      archiveSha256 = $edgeDownload.Sha256
      executableSha256 = Get-Sha256 $edgeDriverPath
      runtimeVersion = $RuntimeVersion
      compatibleFirstThreeComponents = $runtimeMajorMinorBuild
      serviceStarted = $false
      versionProbeExitCode = $edgeProbe.ExitCode
    }
  }
}

function Stage-PinnedArtifactPackage([string] $ToolStage, [string] $Repository, [string] $Token) {
  $apiRoot = 'https://api.github.com/repos/' + $Repository
  $metadata = Invoke-GitHubJson ($apiRoot + '/actions/artifacts/' + $script:Artifact.artifactId) $Token
  if ($metadata.id -ne [long]$script:Artifact.artifactId -or $metadata.name -ne $script:Artifact.artifactName -or
      $metadata.expired -ne $false -or $metadata.size_in_bytes -ne [long]$script:Artifact.artifactSizeBytes -or
      $metadata.digest -cne ('sha256:' + $script:Artifact.outerSha256) -or
      $metadata.workflow_run.id -ne [long]$script:Artifact.runId -or
      $metadata.workflow_run.head_sha -ne $script:Artifact.sourceSha -or
      $metadata.workflow_run.head_branch -ne 'pilot/e003-polaris-dados-2.0') {
    throw 'GitHub artifact metadata does not match the pinned issue 185 source run, attempt, branch, name, size, or digest.'
  }
  $downloads = Join-Path $ToolStage 'downloads'
  [void][IO.Directory]::CreateDirectory($downloads)
  $outerZip = Join-Path $downloads ('issue-185-artifact-' + $script:Artifact.artifactId + '.zip')
  Invoke-WebRequestToFile ($apiRoot + '/actions/artifacts/' + $script:Artifact.artifactId + '/zip') $outerZip $Token
  if ((Get-Item -LiteralPath $outerZip).Length -ne [long]$script:Artifact.artifactSizeBytes -or
      (Get-Sha256 $outerZip) -ne $script:Artifact.outerSha256) {
    throw 'The GitHub artifact ZIP size or outer SHA-256 differs from the exact issue 185 pin.'
  }
  $outerRoot = Join-Path $ToolStage 'source-artifact'
  $outerValidation = Expand-SafeZipArchive $outerZip $outerRoot
  if ($outerValidation.EntryCount -ne 1) { throw 'The pinned outer GitHub artifact must contain exactly one inner ZIP.' }
  $innerZip = Join-Path $outerRoot $script:Artifact.innerName
  if (-not (Test-Path -LiteralPath $innerZip -PathType Leaf) -or
      (Get-Item -LiteralPath $innerZip).Length -ne [long]$script:Artifact.innerSizeBytes -or
      (Get-Sha256 $innerZip) -ne $script:Artifact.innerSha256) {
    throw 'The pinned issue 185 inner package ZIP is missing or has an unexpected size/digest.'
  }
  $packageRoot = Join-Path $ToolStage 'package'
  $innerValidation = Expand-SafeZipArchive $innerZip $packageRoot
  if ($innerValidation.EntryCount -ne [int]$script:Artifact.innerEntryCount -or
      $innerValidation.TotalUncompressedBytes -ne [long]$script:Artifact.innerTotalBytes) {
    throw 'The pinned issue 185 inner package inventory count or total size changed.'
  }
  $pinnedPackage = Assert-PinnedPackage $packageRoot
  return [pscustomobject]@{
    metadata = @{
      repository = $Repository
      artifactId = [string]$metadata.id
      artifactName = [string]$metadata.name
      artifactSizeBytes = [long]$metadata.size_in_bytes
      artifactDigest = [string]$metadata.digest
      runId = [string]$metadata.workflow_run.id
      runAttempt = $script:Artifact.runAttempt
      sourceSha = [string]$metadata.workflow_run.head_sha
      sourceBranch = [string]$metadata.workflow_run.head_branch
      sourceTree = [string]$pinnedPackage.BuildInfo.git.tree
      buildInfo = $pinnedPackage.BuildInfo
      outerSha256 = Get-Sha256 $outerZip
      outerSizeBytes = (Get-Item -LiteralPath $outerZip).Length
      innerSha256 = Get-Sha256 $innerZip
      innerSizeBytes = (Get-Item -LiteralPath $innerZip).Length
      sourceExeSha256 = Get-Sha256 (Join-Path $packageRoot 'morrow.exe')
      buildInfoSha256 = $pinnedPackage.Inventory.buildInfoSha256
      sha256SumsSha256 = $pinnedPackage.Inventory.sha256SumsSha256
      launcherSha256 = $pinnedPackage.Inventory.launcherSha256
      mcpResourceSha256 = $pinnedPackage.Inventory.mcpResourceSha256
      packageFileCount = $pinnedPackage.Inventory.fileCount
      fileInventoryCount = $pinnedPackage.Inventory.fileInventoryCount
      outerEntries = $outerValidation.EntryCount
      innerEntries = $innerValidation.EntryCount
      innerTotalBytes = $innerValidation.TotalUncompressedBytes
    }
    packageRoot = $packageRoot
  }
}

function Assert-StagedArtifactPackage([string] $ToolStage, [object] $StagedMetadata) {
  $downloads = Join-Path $ToolStage 'downloads'
  $outerZip = Join-Path $downloads ('issue-185-artifact-' + $script:Artifact.artifactId + '.zip')
  $outerRoot = Join-Path $ToolStage 'source-artifact'
  $innerZip = Join-Path $outerRoot $script:Artifact.innerName
  $packageRoot = Join-Path $ToolStage 'package'
  if ($StagedMetadata.repository -ne $script:Artifact.repository -or
      $StagedMetadata.artifactId -ne $script:Artifact.artifactId -or
      $StagedMetadata.artifactName -ne $script:Artifact.artifactName -or
      $StagedMetadata.artifactSizeBytes -ne [long]$script:Artifact.artifactSizeBytes -or
      $StagedMetadata.artifactDigest -cne ('sha256:' + $script:Artifact.outerSha256) -or
      $StagedMetadata.runId -ne $script:Artifact.runId -or
      $StagedMetadata.runAttempt -ne $script:Artifact.runAttempt -or
      $StagedMetadata.sourceSha -ne $script:Artifact.sourceSha -or
      $StagedMetadata.sourceTree -ne $script:Artifact.sourceTree -or
      $StagedMetadata.sourceBranch -ne 'pilot/e003-polaris-dados-2.0' -or
      $StagedMetadata.buildInfo.run.id -ne $script:Artifact.runId -or
      $StagedMetadata.buildInfo.run.attempt -ne $script:Artifact.runAttempt -or
      $StagedMetadata.buildInfo.git.head -ne $script:Artifact.sourceSha -or
      $StagedMetadata.buildInfo.git.tree -ne $script:Artifact.sourceTree -or
      $StagedMetadata.buildInfo.overlay.sha256 -ne $script:Artifact.overlaySha256 -or
      $StagedMetadata.buildInfo.template.sha256 -ne $script:Artifact.demoVaultSha256) {
    throw 'The staged GitHub artifact metadata differs from the pinned issue 185 package run.'
  }
  if ($StagedMetadata.outerSizeBytes -ne [long]$script:Artifact.artifactSizeBytes -or
      $StagedMetadata.outerSha256 -cne $script:Artifact.outerSha256 -or
      $StagedMetadata.innerSizeBytes -ne [long]$script:Artifact.innerSizeBytes -or
      $StagedMetadata.innerSha256 -cne $script:Artifact.innerSha256) {
    throw 'The staged outer or inner archive receipt differs from the exact issue 185 pins.'
  }
  if (-not [IO.File]::Exists($outerZip) -or (Get-Item -LiteralPath $outerZip).Length -ne [long]$script:Artifact.artifactSizeBytes -or
      (Get-Sha256 $outerZip) -ne $script:Artifact.outerSha256) {
    throw 'The already-staged GitHub artifact ZIP has an unexpected size or digest.'
  }
  if (-not [IO.File]::Exists($innerZip) -or (Get-Item -LiteralPath $innerZip).Length -ne [long]$script:Artifact.innerSizeBytes -or
      (Get-Sha256 $innerZip) -ne $script:Artifact.innerSha256) {
    throw 'The already-staged inner package ZIP has an unexpected size or digest.'
  }
  if (-not [IO.Directory]::Exists($packageRoot)) { throw 'The issue 178 package has not been extracted into the tool stage.' }
  $outerValidation = Assert-ZipArchiveSafe $outerZip
  $innerValidation = Assert-ZipArchiveSafe $innerZip
  if ($outerValidation.EntryCount -ne 1 -or
      $innerValidation.EntryCount -ne [int]$script:Artifact.innerEntryCount -or
      $innerValidation.EntryCount -ne [int]$StagedMetadata.innerEntries -or
      $innerValidation.TotalUncompressedBytes -ne [long]$script:Artifact.innerTotalBytes -or
      $innerValidation.TotalUncompressedBytes -ne [long]$StagedMetadata.innerTotalBytes) {
    throw 'The staged ZIP directory or uncompressed package inventory differs from its stage receipt.'
  }
  $pinnedPackage = Assert-PinnedPackage $packageRoot
  if ($StagedMetadata.buildInfoSha256 -cne $pinnedPackage.Inventory.buildInfoSha256 -or
      $StagedMetadata.sha256SumsSha256 -cne $pinnedPackage.Inventory.sha256SumsSha256 -or
      $StagedMetadata.launcherSha256 -cne $pinnedPackage.Inventory.launcherSha256 -or
      $StagedMetadata.mcpResourceSha256 -cne $pinnedPackage.Inventory.mcpResourceSha256 -or
      $StagedMetadata.sourceExeSha256 -cne $pinnedPackage.Pe.sha256 -or
      $StagedMetadata.packageFileCount -ne $pinnedPackage.Inventory.fileCount -or
      $StagedMetadata.fileInventoryCount -ne $pinnedPackage.Inventory.fileInventoryCount) {
    throw 'The staged package BUILD-INFO, resource inventory, launcher, or executable binding changed.'
  }
  return [pscustomobject]@{
    metadata = $StagedMetadata
    packageRoot = $packageRoot
    buildInfo = $pinnedPackage.BuildInfo
    pe = $pinnedPackage.Pe
  }
}

function Get-VerifiedStagedEdgeDriverVersion([object] $EdgeDriver, [string] $RuntimeVersion) {
  $edgeUrl = [string]$EdgeDriver.downloadUrl
  $releaseUrlMatch = [regex]::Match(
    $edgeUrl,
    '^https://msedgedriver\.microsoft\.com/(?<version>\d+\.\d+\.\d+\.\d+)/edgedriver_win64\.zip\z',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $releaseUrlMatch.Success) { throw 'The staged Microsoft EdgeDriver source is not the official x64 Microsoft download.' }
  $edgeReleaseVersion = $releaseUrlMatch.Groups['version'].Value

  if ($EdgeDriver.sourcePageUrl -cne $script:OfficialEdgeDriverPageUrl -or
      $EdgeDriver.sourceCatalogUrl -cne $script:OfficialEdgeDriverCatalogUrl -or
      $EdgeDriver.responseUrl -cne $edgeUrl -or
      [string]$EdgeDriver.catalogSha256 -notmatch '^[0-9a-f]{64}$' -or
      [long]$EdgeDriver.catalogSizeBytes -le 0 -or
      [long]$EdgeDriver.catalogSizeBytes -gt $script:MaxOfficialCatalogBytes -or
      [int]$EdgeDriver.catalogItemCount -le 0 -or
      [int]$EdgeDriver.catalogItemCount -gt $script:MaxOfficialCatalogItems -or
      [int]$EdgeDriver.compatibleCandidateCount -le 0 -or
      [long]$EdgeDriver.expectedArchiveBytes -le 0 -or
      [long]$EdgeDriver.expectedArchiveBytes -gt $script:MaxOfficialDriverBytes -or
      [long]$EdgeDriver.archiveSizeBytes -ne [long]$EdgeDriver.expectedArchiveBytes -or
      [string]$EdgeDriver.archiveSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$EdgeDriver.executableSha256 -notmatch '^[0-9a-f]{64}$' -or
      $EdgeDriver.contentType -cnotin @('application/x-zip-compressed', 'application/zip', 'application/octet-stream')) {
    throw 'The staged Microsoft EdgeDriver source is not the official x64 Microsoft download.'
  }
  try { [void][DateTimeOffset]::Parse([string]$EdgeDriver.catalogGeneratedAt, [Globalization.CultureInfo]::InvariantCulture) }
  catch { throw 'The staged Microsoft EdgeDriver catalog generation time is malformed.' }
  try { [void][DateTimeOffset]::Parse([string]$EdgeDriver.selectedLastModified, [Globalization.CultureInfo]::InvariantCulture) }
  catch { throw 'The selected Microsoft EdgeDriver lastModified time is malformed.' }
  if ([string]$RuntimeVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    throw 'The current WebView2 pv is not a four-component version.'
  }
  $runtimeMajorMinorBuild = ($RuntimeVersion.Split('.')[0..2] -join '.')
  if ($edgeReleaseVersion -cne [string]$EdgeDriver.version -or
      ($edgeReleaseVersion.Split('.')[0..2] -join '.') -cne $runtimeMajorMinorBuild -or
      [string]$EdgeDriver.runtimeVersion -cne $RuntimeVersion) {
    throw 'The staged Microsoft EdgeDriver does not match the WebView2 runtime first-three-component requirement.'
  }
  return $edgeReleaseVersion
}

function Verify-StagedDrivers([object] $StagedDrivers, [string] $ToolStage, [string] $ControlPath, [string] $RuntimeVersion) {
  $tauriRoot = Join-Path $ToolStage 'drivers/tauri-driver'
  $tauriDriverPath = Join-Path $ToolStage 'drivers/tauri-driver/bin/tauri-driver.exe'
  if ($StagedDrivers.tauriDriver.version -ne $script:TauriDriver.version -or
      $StagedDrivers.tauriDriver.sourceUrl -ne $script:TauriDriver.sourceUrl -or
      $StagedDrivers.tauriDriver.downloadUrl -ne $script:TauriDriver.downloadUrl -or
      -not [IO.File]::Exists($tauriDriverPath) -or
      (Get-Sha256 $tauriDriverPath) -ne $StagedDrivers.tauriDriver.executableSha256) {
    throw 'The already-staged tauri-driver is missing or differs from the pinned crates.io release receipt.'
  }
  Assert-NoReparsePath $tauriDriverPath 'Staged tauri-driver executable' | Out-Null
  $cargo = Get-Command cargo -ErrorAction Stop
  $tauriList = Invoke-CapturedCommand $cargo.Source @('install', '--list', '--root', $tauriRoot) $ToolStage (Join-Path $ControlPath 'tauri-driver-checkonly-install-list.log') 120
  $tauriVersion = Get-CargoInstalledPackageVersion ($tauriList.StdOut + [Environment]::NewLine + $tauriList.StdErr) 'tauri-driver' $script:TauriDriver.version
  if ($tauriVersion -ne $StagedDrivers.tauriDriver.version) { throw 'The staged tauri-driver installation metadata changed after tool staging.' }

  $edgeRoot = Join-Path $ToolStage 'drivers/msedgedriver'
  $edgeArchive = Join-Path $ToolStage 'drivers/msedgedriver.zip'
  $edgeExecutables = @(Get-ChildItem -LiteralPath $edgeRoot -Filter 'msedgedriver.exe' -File -Recurse -Force)
  if ($edgeExecutables.Count -ne 1 -or -not [IO.File]::Exists($edgeArchive) -or
      (Get-Item -LiteralPath $edgeArchive).Length -ne [long]$StagedDrivers.edgeDriver.archiveSizeBytes -or
      (Get-Sha256 $edgeArchive) -ne $StagedDrivers.edgeDriver.archiveSha256) {
    throw 'The already-staged Microsoft EdgeDriver archive or executable is missing or changed.'
  }
  $edgeReleaseVersion = Get-VerifiedStagedEdgeDriverVersion $StagedDrivers.edgeDriver $RuntimeVersion
  $edgeDriverPath = $edgeExecutables[0].FullName
  Assert-NoReparsePath $edgeDriverPath 'Staged Microsoft EdgeDriver executable' | Out-Null
  if ((Get-Sha256 $edgeDriverPath) -ne $StagedDrivers.edgeDriver.executableSha256) {
    throw 'The staged Microsoft EdgeDriver executable digest differs from its stage receipt.'
  }
  $edgeProbe = Invoke-CapturedCommand $edgeDriverPath @('--version') $ToolStage (Join-Path $ControlPath 'msedgedriver-checkonly-version.log') 30 -VersionProbe
  $edgeVersion = Get-VersionFromOutput $edgeProbe.StdOut 'msedgedriver'
  if ($edgeVersion -ne $edgeReleaseVersion) { throw 'The staged Microsoft EdgeDriver --version probe differs from its official download version.' }

  return [pscustomobject]@{
    cargo = $StagedDrivers.cargo
    tauriDriver = @{
      version = $tauriVersion
      installedPackageMetadata = 'cargo install --list --root <tool-stage>/drivers/tauri-driver'
      installedBinaryName = 'tauri-driver.exe'
      source = $StagedDrivers.tauriDriver.source
      sourceUrl = $StagedDrivers.tauriDriver.sourceUrl
      downloadUrl = $StagedDrivers.tauriDriver.downloadUrl
      executablePath = Get-SanitizedPath $tauriDriverPath
      installCommand = $StagedDrivers.tauriDriver.installCommand
      executableSha256 = Get-Sha256 $tauriDriverPath
      serviceStarted = $false
      installListExitCode = $tauriList.ExitCode
      installExitCode = $StagedDrivers.tauriDriver.installExitCode
    }
    edgeDriver = $StagedDrivers.edgeDriver
  }
}

function Set-ControlReceipt([string] $ControlPath, [object] $Receipt) {
  if (-not [IO.Directory]::Exists($ControlPath)) { [void][IO.Directory]::CreateDirectory($ControlPath) }
  $safePath = Join-Path $ControlPath 'receipt.json'
  $json = $Receipt | ConvertTo-Json -Depth 15
  [IO.File]::WriteAllText($safePath, $json, [Text.UTF8Encoding]::new($false))
}

function Set-EdgeDriverDiscoveryReceipt([string] $ControlPath, [object] $Discovery) {
  $receiptPath = Join-Path $ControlPath 'receipt.json'
  if (-not [IO.File]::Exists($receiptPath)) { throw 'The control receipt is missing before EdgeDriver discovery.' }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($receipt.status -ne 'initializing') { throw 'EdgeDriver discovery can update only an initializing preflight receipt.' }
  $receipt | Add-Member -NotePropertyName 'edgeDriverDiscovery' -NotePropertyValue $Discovery -Force
  Set-ControlReceipt $ControlPath $receipt
}

function Set-PreflightReceiptStatus([object] $Receipt, [ValidateSet('staged', 'passed', 'failed')][string] $NextStatus) {
  $allowed = switch ([string]$Receipt.status) {
    'initializing' { @('staged', 'failed'); break }
    'staged' { @('passed', 'failed'); break }
    'passed' { @(); break }
    'failed' { @(); break }
    default { throw 'The preflight receipt has an unknown lifecycle status.' }
  }
  if ($NextStatus -notin $allowed) { throw "Invalid preflight receipt transition: $($Receipt.status) to $NextStatus." }
  $Receipt.status = $NextStatus
  return $Receipt
}

function Set-PreflightReceiptFailure([object] $Receipt, [string] $Failure, [string] $CompletedAtUtc) {
  $Receipt = Set-PreflightReceiptStatus $Receipt 'failed'
  if ($Receipt -is [System.Collections.IDictionary]) {
    $Receipt['failure'] = $Failure
    $Receipt['completedAtUtc'] = $CompletedAtUtc
  } else {
    $Receipt | Add-Member -NotePropertyName 'failure' -NotePropertyValue $Failure -Force
    $Receipt | Add-Member -NotePropertyName 'completedAtUtc' -NotePropertyValue $CompletedAtUtc -Force
  }
  return $Receipt
}

function Write-ControlJson([string] $ControlPath, [string] $FileName, [object] $Value) {
  if (-not [IO.Directory]::Exists($ControlPath)) { throw 'The separate control directory is missing.' }
  if ($FileName -notin @('stage.json')) { throw 'Unexpected control metadata filename.' }
  $safePath = Join-Path $ControlPath $FileName
  [IO.File]::WriteAllText($safePath, ($Value | ConvertTo-Json -Depth 15), [Text.UTF8Encoding]::new($false))
}

function Get-PreflightContext([string[]] $AllowedReceiptStatuses) {
  if ($env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64') { throw 'Preflight must run on a GitHub-hosted Windows x64 runner.' }
  if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID) -or [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT) -or
      [string]::IsNullOrWhiteSpace($env:GITHUB_SHA) -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'GitHub Actions run metadata or RUNNER_TEMP is unavailable.'
  }
  if ($env:GITHUB_REF -ne 'refs/heads/codex/e003-g07-windows-runtime' -or $env:GITHUB_EVENT_NAME -ne 'push') {
    throw 'This preflight accepts push runs only from the exact Windows-runtime Codex branch.'
  }
  if ($env:GITHUB_REPOSITORY -ne $script:Artifact.repository) { throw 'The preflight is running in an unexpected repository.' }

  $paths = Get-PreflightPaths $env:RUNNER_TEMP $env:GITHUB_RUN_ID $env:GITHUB_RUN_ATTEMPT $env:GITHUB_SHA
  $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path.TrimEnd('\') + '\'
  foreach ($stagePath in @($paths.ToolStage, $paths.Control, $paths.PlannedRoot)) {
    if ($stagePath.StartsWith($repoRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Tool-stage, control, and planned pilot paths must stay outside the checkout.'
    }
  }
  $controlPath = $paths.Control
  if (-not [IO.Directory]::Exists($controlPath)) { [void][IO.Directory]::CreateDirectory($controlPath) }
  Assert-NoReparsePath $controlPath 'Control receipt directory' | Out-Null
  $receiptPath = Join-Path $controlPath 'receipt.json'
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw 'The control receipt must be initialized by the workflow before preflight starts.'
  }
  $initial = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($initial.status -notin $AllowedReceiptStatuses -or $initial.runId -ne $env:GITHUB_RUN_ID -or
      $initial.runAttempt -ne $env:GITHUB_RUN_ATTEMPT -or $initial.sha -ne $env:GITHUB_SHA) {
    throw 'The control receipt does not match this workflow run.'
  }
  return [pscustomobject]@{ Paths = $paths; Receipt = $initial; ControlPath = $controlPath }
}

function Stage-WindowsPreflight {
  $context = Get-PreflightContext @('initializing')
  $paths = $context.Paths
  if ([IO.Directory]::Exists($paths.ToolStage) -or [IO.File]::Exists($paths.ToolStage)) {
    throw 'The per-run tool/download stage already exists; the preflight will not reuse or clean it.'
  }
  [void][IO.Directory]::CreateDirectory($paths.ToolStage)
  Assert-NoReparsePath $paths.ToolStage 'Tool/download stage' | Out-Null
  $runtime = Get-WebView2Runtime
  $runtimeObservation = [ordered]@{
    selection = 'Microsoft documented 64-bit WebView2 pv values; exact HKLM/HKCU agreement required'
    version = $runtime.Version
    sources = $runtime.Sources
    recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    recordedBeforeDriverDiscovery = $true
  }
  $context.Receipt | Add-Member -NotePropertyName 'webView2Runtime' -NotePropertyValue $runtimeObservation -Force
  $context.Receipt | Add-Member -NotePropertyName 'edgeDriverDiscovery' -NotePropertyValue ([ordered]@{
    status = 'pending'
    sourcePageUrl = $script:OfficialEdgeDriverPageUrl
    sourceCatalogUrl = $script:OfficialEdgeDriverCatalogUrl
  }) -Force
  $context.Receipt.scope = 'Morrow E003 G13 issue 185 preflight only'
  Set-ControlReceipt $context.ControlPath $context.Receipt
  $artifact = Stage-PinnedArtifactPackage $paths.ToolStage $script:Artifact.repository $env:GITHUB_TOKEN
  $drivers = Install-AndVerifyDrivers $paths.ToolStage $context.ControlPath $runtime.Version
  $stage = [ordered]@{
    schemaVersion = 1
    status = 'staged'
    scope = 'Morrow E003 G13 issue 185 tool/download stage only'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    sha = $env:GITHUB_SHA
    branch = 'codex/e003-g07-windows-runtime'
    runtimeVersion = $runtime.Version
    runtimeSources = $runtime.Sources
    artifact = $artifact.metadata
    drivers = $drivers
    appLaunched = $false
    driverServiceStarted = $false
    completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  }
  Write-ControlJson $context.ControlPath 'stage.json' $stage
  $receipt = [ordered]@{
    schemaVersion = 1
    status = 'initializing'
    scope = 'Morrow E003 G13 issue 185 preflight only'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    sha = $env:GITHUB_SHA
    branch = 'codex/e003-g07-windows-runtime'
    stageManifest = 'stage.json'
    webView2Runtime = $runtimeObservation
    edgeDriverDiscovery = $drivers.edgeDriver
    appLaunched = $false
    driverServiceStarted = $false
    stagedAtUtc = $stage.completedAtUtc
  }
  $receipt = Set-PreflightReceiptStatus $receipt 'staged'
  Set-ControlReceipt $context.ControlPath $receipt
  return $stage
}

function Invoke-WindowsPreflightCheckOnly {
  $context = Get-PreflightContext @('staged')
  $paths = $context.Paths
  if (-not [IO.Directory]::Exists($paths.ToolStage)) { throw 'The tool/download stage is missing; check-only never downloads or installs tools.' }
  Assert-NoReparsePath $paths.ToolStage 'Tool/download stage' | Out-Null
  $stageManifestPath = Join-Path $context.ControlPath 'stage.json'
  if (-not [IO.File]::Exists($stageManifestPath)) { throw 'The separate tool-stage manifest is missing.' }
  $stage = Get-Content -LiteralPath $stageManifestPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($stage.schemaVersion -ne 1 -or $stage.status -ne 'staged' -or
      $stage.runId -ne $env:GITHUB_RUN_ID -or $stage.runAttempt -ne $env:GITHUB_RUN_ATTEMPT -or
      $stage.sha -ne $env:GITHUB_SHA -or $stage.branch -ne 'codex/e003-g07-windows-runtime' -or
      $stage.appLaunched -ne $false -or $stage.driverServiceStarted -ne $false) {
    throw 'The separate stage manifest does not match this run or its no-launch boundary.'
  }
  $identity = Get-CurrentWindowsIdentity
  $knownFolders = Get-WindowsKnownFolderPaths
  $localPilotRoot = Assert-NoKnownFolderPilotCollision $knownFolders.LocalAppData $script:Artifact.pilotIdentifier 'LocalAppData pilot metadata'
  $roamingPilotRoot = Assert-NoKnownFolderPilotCollision $knownFolders.RoamingAppData $script:Artifact.pilotIdentifier 'RoamingAppData pilot metadata'
  $windowState = Join-Path $roamingPilotRoot '.window-state.json'
  Assert-LocalNormalizedPath $windowState 'Tauri window-state metadata plan' | Out-Null
  if ([IO.File]::Exists($windowState) -or [IO.Directory]::Exists($windowState)) {
    throw 'The pilot Tauri window-state path already exists; existing Windows profile metadata is preserved.'
  }

  $runtime = Get-WebView2Runtime
  if ($runtime.Version -ne $stage.runtimeVersion) {
    throw 'The WebView2 runtime pv changed between tool staging and check-only; stage again on a clean run.'
  }
  $artifact = Assert-StagedArtifactPackage $paths.ToolStage $stage.artifact
  $drivers = Verify-StagedDrivers $stage.drivers $paths.ToolStage $context.ControlPath $runtime.Version
  $innerZip = Join-Path (Join-Path $paths.ToolStage 'source-artifact') $script:Artifact.innerName
  $launcherVerification = Assert-StagedLauncherMatchesZip $innerZip $artifact.packageRoot
  $checkOnly = Invoke-PackageCheckOnly $artifact.packageRoot
  $planned = [ordered]@{
    toolStage = Get-SanitizedPath $paths.ToolStage
    case = Get-SanitizedPath $paths.Case
    vault = Get-SanitizedPath $paths.Vault
    profile = Get-SanitizedPath $paths.Profile
    evidence = Get-SanitizedPath $paths.Evidence
    retained = Get-SanitizedPath $paths.Retained
    requestedChildEnvironment = @{
      MORROW_USER_DATA = Get-SanitizedPath $paths.MorrowUserData
      WEBVIEW2_USER_DATA_FOLDER = Get-SanitizedPath $paths.WebView2UserData
      appliedToAnyProcess = $false
    }
    localAppDataPilotMetadata = Get-SanitizedPath $localPilotRoot
    roamingAppDataPilotWindowState = Get-SanitizedPath $windowState
    newPathsCreatedByCheckOnly = $false
    environmentPathsAreRequestsOnly = $true
    profileObserved = $false
  }
  foreach ($name in @('Case', 'Vault', 'Profile', 'Evidence', 'Retained', 'MorrowUserData', 'WebView2UserData')) {
    if ([IO.File]::Exists([string]$paths.$name) -or [IO.Directory]::Exists([string]$paths.$name)) {
      throw "Check-only created or collided with the planned $name path."
    }
  }
  if ([IO.Directory]::Exists($localPilotRoot) -or [IO.File]::Exists($localPilotRoot) -or
      [IO.Directory]::Exists($roamingPilotRoot) -or [IO.File]::Exists($roamingPilotRoot)) {
    throw 'Check-only created or collided with a planned pilot KnownFolder metadata path.'
  }

  $receipt = [ordered]@{
    schemaVersion = 1
    status = 'staged'
    scope = 'Morrow E003 G13 issue 185 preflight only'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    sha = $env:GITHUB_SHA
    branch = 'codex/e003-g07-windows-runtime'
    runner = @{ os = $env:RUNNER_OS; architecture = $env:RUNNER_ARCH; name = $env:RUNNER_NAME; imageOs = $env:ImageOS; imageVersion = $env:ImageVersion }
    ciIdentity = @{ sid = $identity.Sid; account = $identity.Account }
    webView2Runtime = @{ selection = 'Microsoft documented pv REG_SZ; exact 64-bit HKLM/HKCU agreement required'; version = $runtime.Version; sources = $runtime.Sources }
    edgeDriverDiscovery = $drivers.edgeDriver
    sourceArtifact = $artifact.metadata
    package = @{ buildInfoRun = $artifact.buildInfo.run; applicationVersion = $artifact.buildInfo.applicationVersion; pilotIdentifier = $artifact.buildInfo.pilotIdentifier; pe = $artifact.pe }
    drivers = $drivers
    knownFolders = @{ localAppData = Get-SanitizedPath $knownFolders.LocalAppData; roamingAppData = Get-SanitizedPath $knownFolders.RoamingAppData; api = 'SHGetKnownFolderPath' }
    plannedPaths = $planned
    packageCheckOnlyBoundary = 'The extracted issue 178 launcher prepared a child-process environment and exited before creating PilotState or starting morrow.exe.'
    packageLauncherVerification = $launcherVerification
    packageCheckOnly = $checkOnly
    appLaunched = $false
    driverServiceStarted = $false
    windowsRuntimeTested = $false
    guiTested = $false
    completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $receipt = Set-PreflightReceiptStatus $receipt 'passed'
  Set-ControlReceipt $context.ControlPath $receipt
  return $receipt
}

function Invoke-PreflightMode([string] $SelectedMode, [scriptblock] $StageAction, [scriptblock] $CheckOnlyAction) {
  switch ($SelectedMode) {
    'Stage' {
      if ($null -eq $StageAction) { $StageAction = { Stage-WindowsPreflight } }
      return (& $StageAction)
    }
    'CheckOnly' {
      if ($null -eq $CheckOnlyAction) { $CheckOnlyAction = { Invoke-WindowsPreflightCheckOnly } }
      return (& $CheckOnlyAction)
    }
    default { throw 'The preflight mode must be Stage or CheckOnly.' }
  }
}

if ($LibraryOnly) { return }

$runControl = Join-Path $env:RUNNER_TEMP ("issue-179-control-" + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)
$initialReceipt = [ordered]@{
  schemaVersion = 1
  status = 'initializing'
  scope = 'Morrow E003 G13 issue 179 preflight only'
  runId = $env:GITHUB_RUN_ID
  runAttempt = $env:GITHUB_RUN_ATTEMPT
  sha = $env:GITHUB_SHA
  appLaunched = $false
  driverServiceStarted = $false
  startedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
}
try {
  if (-not [IO.Directory]::Exists($runControl)) { [void][IO.Directory]::CreateDirectory($runControl) }
  if ($Mode -eq 'Stage' -and -not (Test-Path -LiteralPath (Join-Path $runControl 'receipt.json') -PathType Leaf)) {
    Set-ControlReceipt $runControl $initialReceipt
  }
  $result = Invoke-PreflightMode $Mode
  Write-Output (($result | ConvertTo-Json -Depth 15 -Compress))
  exit 0
} catch {
  $failure = Get-SafeError $_
  $receiptPath = Join-Path $runControl 'receipt.json'
  try {
    $failureReceipt = if ([IO.File]::Exists($receiptPath)) { Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json -ErrorAction Stop } else { $initialReceipt }
    $failureReceipt = Set-PreflightReceiptFailure $failureReceipt $failure ([DateTimeOffset]::UtcNow.ToString('o'))
    Set-ControlReceipt $runControl $failureReceipt
  } catch {}
  Write-Error 'Windows preflight failed closed; see the sanitized control receipt/logs.'
  exit 1
}
