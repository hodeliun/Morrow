. (Join-Path $PSScriptRoot 'windows-native-process-policy.ps1')

function New-PilotWindowsNativeProcessJsonlException {
  param(
    [Parameter(Mandatory)][string] $ErrorId,
    [Parameter(Mandatory)][string] $Stage
  )

  $exception = [InvalidOperationException]::new('The JSONL request was rejected.')
  $exception.Data['Morrow.WindowsNativeProcess.Jsonl.ErrorId'] = $ErrorId
  $exception.Data['Morrow.WindowsNativeProcess.Jsonl.Diagnostics'] = [ordered]@{
    stage = $Stage
    fields = @()
  }
  return $exception
}

function Get-PilotWindowsNativeProcessJsonlErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)

  $current = $Exception
  for ($depth = 0; $null -ne $current -and $depth -lt 8; $depth++) {
    if ($current.Data.Contains('Morrow.WindowsNativeProcess.Jsonl.ErrorId')) {
      return [string]$current.Data['Morrow.WindowsNativeProcess.Jsonl.ErrorId']
    }
    $current = $current.InnerException
  }
  return $null
}

function Add-PilotWindowsNativeProcessJsonlByteSlice {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[byte]] $Target,
    [Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Source,
    [Parameter(Mandatory)][int] $Offset,
    [Parameter(Mandatory)][int] $Count
  )

  for ($index = 0; $index -lt $Count; $index++) {
    $Target.Add($Source[$Offset + $index])
  }
}

function Find-PilotWindowsNativeProcessJsonlLineFeed {
  param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]] $Bytes)

  for ($index = 0; $index -lt $Bytes.Length; $index++) {
    if ($Bytes[$index] -eq 10) { return $index }
  }
  return -1
}

function Assert-PilotWindowsNativeProcessJsonlPartialSize {
  param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[byte]] $Frame)

  if ($Frame.Count -gt 262145) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge' `
      -Stage 'frame-size')
  }
  if ($Frame.Count -eq 262145 -and $Frame[$Frame.Count - 1] -ne 13) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge' `
      -Stage 'frame-size')
  }
}

function Get-PilotWindowsNativeProcessJsonlFrameBytes {
  param([Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[byte]] $Frame)

  $rawBytes = $Frame.ToArray()
  $contentLength = $rawBytes.Length
  if ($contentLength -gt 0 -and $rawBytes[$contentLength - 1] -eq 13) { $contentLength-- }
  if ($contentLength -gt 262144) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge' `
      -Stage 'frame-size')
  }
  for ($index = 0; $index -lt $contentLength; $index++) {
    if ($rawBytes[$index] -eq 13) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidLineEnding' `
        -Stage 'line-ending')
    }
  }

  $content = [byte[]]::new($contentLength)
  if ($contentLength -gt 0) { [Array]::Copy($rawBytes, 0, $content, 0, $contentLength) }
  return [pscustomobject]@{ Bytes = $content }
}

function Read-PilotWindowsNativeProcessJsonlFrame {
  param([Parameter(Mandatory)][object] $ReaderContext)

  $frame = [System.Collections.Generic.List[byte]]::new()
  $buffer = [byte[]]::new(4096)
  $frequency = [Diagnostics.Stopwatch]::Frequency
  $deadlineTicks = [Diagnostics.Stopwatch]::GetTimestamp() +
    [long][Math]::Ceiling(($ReaderContext.FrameTimeoutMilliseconds * [double]$frequency) / 1000.0)

  while ($true) {
    if ($ReaderContext.PendingBytes.Count -gt 0) {
      $pending = $ReaderContext.PendingBytes.ToArray()
      $ReaderContext.PendingBytes.Clear()
      $lineFeedIndex = Find-PilotWindowsNativeProcessJsonlLineFeed -Bytes $pending
      if ($lineFeedIndex -ge 0) {
        Add-PilotWindowsNativeProcessJsonlByteSlice -Target $frame -Source $pending -Offset 0 -Count $lineFeedIndex
        Add-PilotWindowsNativeProcessJsonlByteSlice `
          -Target $ReaderContext.PendingBytes `
          -Source $pending `
          -Offset ($lineFeedIndex + 1) `
          -Count ($pending.Length - $lineFeedIndex - 1)
        return (Get-PilotWindowsNativeProcessJsonlFrameBytes -Frame $frame)
      }
      Add-PilotWindowsNativeProcessJsonlByteSlice -Target $frame -Source $pending -Offset 0 -Count $pending.Length
      Assert-PilotWindowsNativeProcessJsonlPartialSize -Frame $frame
    }

    $remainingTicks = $deadlineTicks - [Diagnostics.Stopwatch]::GetTimestamp()
    if ($remainingTicks -le 0) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.DeadlineExceeded' `
        -Stage 'frame-deadline')
    }
    $remainingMilliseconds = [int][Math]::Max(
      1,
      [Math]::Ceiling(($remainingTicks * 1000.0) / $frequency)
    )

    $cancellation = [Threading.CancellationTokenSource]::new()
    try {
      $readTask = $ReaderContext.Stream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token)
      if (-not $readTask.Wait($remainingMilliseconds) -or
          [Diagnostics.Stopwatch]::GetTimestamp() -gt $deadlineTicks) {
        $cancellation.Cancel()
        $ReaderContext.Terminated = $true
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.DeadlineExceeded' `
          -Stage 'frame-deadline')
      }
      $bytesRead = $readTask.GetAwaiter().GetResult()
    } catch {
      $jsonlErrorId = Get-PilotWindowsNativeProcessJsonlErrorId -Exception $_.Exception
      if (-not [string]::IsNullOrEmpty($jsonlErrorId)) { throw }
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.ReadFailed' `
        -Stage 'frame-read')
    } finally {
      $cancellation.Dispose()
    }

    if ($bytesRead -eq 0) {
      if ($frame.Count -eq 0) {
        $ReaderContext.Eof = $true
        return $null
      }
      if ($frame.Count -gt 262144) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.FrameTooLarge' `
          -Stage 'frame-size')
      }
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.UnexpectedPartialEof' `
        -Stage 'frame-eof')
    }

    $readBytes = [byte[]]::new($bytesRead)
    [Array]::Copy($buffer, 0, $readBytes, 0, $bytesRead)
    $lineFeedIndex = Find-PilotWindowsNativeProcessJsonlLineFeed -Bytes $readBytes
    if ($lineFeedIndex -ge 0) {
      Add-PilotWindowsNativeProcessJsonlByteSlice -Target $frame -Source $readBytes -Offset 0 -Count $lineFeedIndex
      Add-PilotWindowsNativeProcessJsonlByteSlice `
        -Target $ReaderContext.PendingBytes `
        -Source $readBytes `
        -Offset ($lineFeedIndex + 1) `
        -Count ($readBytes.Length - $lineFeedIndex - 1)
      return (Get-PilotWindowsNativeProcessJsonlFrameBytes -Frame $frame)
    }
    Add-PilotWindowsNativeProcessJsonlByteSlice -Target $frame -Source $readBytes -Offset 0 -Count $bytesRead
    Assert-PilotWindowsNativeProcessJsonlPartialSize -Frame $frame
  }
}

function Assert-PilotWindowsNativeProcessJsonlNoDuplicateProperties {
  param(
    [Parameter(Mandatory)][System.Text.Json.JsonElement] $Element,
    [Parameter(Mandatory)][int] $ContainerDepth
  )

  if ($ContainerDepth -gt 12) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.DepthExceeded' `
      -Stage 'json-depth')
  }

  switch ($Element.ValueKind.ToString()) {
    'Object' {
      $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($property in $Element.EnumerateObject()) {
        if (-not $seen.Add($property.Name)) {
          throw (New-PilotWindowsNativeProcessJsonlException `
            -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateProperty' `
            -Stage 'json-duplicate-property')
        }
        if ($property.Value.ValueKind -in @(
            [System.Text.Json.JsonValueKind]::Object,
            [System.Text.Json.JsonValueKind]::Array
          )) {
          Assert-PilotWindowsNativeProcessJsonlNoDuplicateProperties `
            -Element $property.Value `
            -ContainerDepth ($ContainerDepth + 1)
        }
      }
    }
    'Array' {
      foreach ($item in $Element.EnumerateArray()) {
        if ($item.ValueKind -in @(
            [System.Text.Json.JsonValueKind]::Object,
            [System.Text.Json.JsonValueKind]::Array
          )) {
          Assert-PilotWindowsNativeProcessJsonlNoDuplicateProperties `
            -Element $item `
            -ContainerDepth ($ContainerDepth + 1)
        }
      }
    }
  }
}

function ConvertFrom-PilotWindowsNativeProcessJsonlElement {
  param([Parameter(Mandatory)][System.Text.Json.JsonElement] $Element)

  switch ($Element.ValueKind.ToString()) {
    'Object' {
      $converted = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
      foreach ($property in $Element.EnumerateObject()) {
        $converted.Add(
          $property.Name,
          (ConvertFrom-PilotWindowsNativeProcessJsonlElement -Element $property.Value)
        )
      }
      return ,$converted
    }
    'Array' {
      $items = [System.Collections.Generic.List[object]]::new()
      foreach ($item in $Element.EnumerateArray()) {
        $items.Add((ConvertFrom-PilotWindowsNativeProcessJsonlElement -Element $item))
      }
      return ,$items.ToArray()
    }
    'String' { return $Element.GetString() }
    'Number' {
      $rawNumber = $Element.GetRawText()
      if ($rawNumber -cmatch '\A-?(?:0|[1-9][0-9]*)\z') {
        $bigInteger = [System.Numerics.BigInteger]::Parse(
          $rawNumber,
          [Globalization.NumberStyles]::Integer,
          [Globalization.CultureInfo]::InvariantCulture
        )
        if ($bigInteger -ge [long]::MinValue -and $bigInteger -le [long]::MaxValue) {
          return [long]$bigInteger
        }
        return $bigInteger
      }

      $decimalValue = [decimal]0
      if ([decimal]::TryParse(
          $rawNumber,
          [Globalization.NumberStyles]::Float,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$decimalValue
        )) {
        return $decimalValue
      }
      $doubleValue = [double]0
      if ([double]::TryParse(
          $rawNumber,
          [Globalization.NumberStyles]::Float,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$doubleValue
        )) {
        return $doubleValue
      }
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'json-number')
    }
    'True' { return $true }
    'False' { return $false }
    'Null' { return $null }
    default {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'json-value')
    }
  }
}

function Test-PilotWindowsNativeProcessJsonlIntegerElement {
  param(
    [Parameter(Mandatory)][System.Text.Json.JsonElement] $Element,
    [Parameter(Mandatory)][long] $Minimum,
    [Parameter(Mandatory)][long] $Maximum,
    [ref] $Value
  )

  if ($Element.ValueKind -ne [System.Text.Json.JsonValueKind]::Number) { return $false }
  $rawNumber = $Element.GetRawText()
  if ($rawNumber -cnotmatch '\A-?(?:0|[1-9][0-9]*)\z') { return $false }
  $parsed = [long]0
  if (-not [long]::TryParse(
      $rawNumber,
      [Globalization.NumberStyles]::Integer,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$parsed
    )) {
    return $false
  }
  if ($parsed -lt $Minimum -or $parsed -gt $Maximum) { return $false }
  $Value.Value = $parsed
  return $true
}

function Test-PilotWindowsNativeProcessJsonlGuidD {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string] $Value,
    [Parameter(Mandatory)][ref] $GuidValue
  )

  $parsedGuid = [Guid]::Empty
  if ($Value.Length -ne 36 -or
      $Value -cnotmatch '\A[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\z' -or
      -not [Guid]::TryParseExact($Value, 'D', [ref]$parsedGuid) -or
      -not [string]::Equals($Value, $parsedGuid.ToString('D'), [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }

  $GuidValue.Value = $parsedGuid
  return $true
}

function Get-PilotWindowsNativeProcessJsonlSafeValidationErrorId {
  param([Parameter(Mandatory)][Exception] $Exception)

  $policyErrorId = Get-PilotWindowsNativeProcessErrorId -Exception $Exception
  switch ($policyErrorId) {
    'Morrow.WindowsNativeProcess.InvalidDescriptor' { return 'Morrow.WindowsNativeProcess.Jsonl.InvalidDescriptor' }
    'Morrow.WindowsNativeProcess.InvalidIdentityAssertion' { return 'Morrow.WindowsNativeProcess.Jsonl.InvalidIdentityAssertion' }
    'Morrow.WindowsNativeProcess.InvalidStopTimeout' { return 'Morrow.WindowsNativeProcess.Jsonl.InvalidTimeout' }
    default { return 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' }
  }
}

function ConvertFrom-PilotWindowsNativeProcessJsonlRequest {
  param([Parameter(Mandatory)][AllowEmptyString()][string] $FrameText)

  $document = $null
  try {
    $options = [System.Text.Json.JsonDocumentOptions]::new()
    $options.MaxDepth = 64
    $options.AllowTrailingCommas = $false
    $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
    $document = [System.Text.Json.JsonDocument]::Parse($FrameText, $options)
  } catch {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.MalformedJson' `
      -Stage 'json-parse')
  }

  try {
    $root = $document.RootElement
    Assert-PilotWindowsNativeProcessJsonlNoDuplicateProperties -Element $root -ContainerDepth 1
    if ($root.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'root-shape')
    }

    $rootProperties = [System.Collections.Generic.Dictionary[string, System.Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
    foreach ($property in $root.EnumerateObject()) { $rootProperties.Add($property.Name, $property.Value) }
    foreach ($requiredName in @('version', 'requestId', 'operation')) {
      if (-not $rootProperties.ContainsKey($requiredName)) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'root-shape')
      }
    }

    $version = [long]0
    if (-not (Test-PilotWindowsNativeProcessJsonlIntegerElement `
        -Element $rootProperties['version'] -Minimum 1 -Maximum 1 -Value ([ref]$version))) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'version-validation')
    }

    if ($rootProperties['requestId'].ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'request-id-validation')
    }
    $requestId = $rootProperties['requestId'].GetString()
    $requestIdGuid = [Guid]::Empty
    if (-not (Test-PilotWindowsNativeProcessJsonlGuidD -Value $requestId -GuidValue ([ref]$requestIdGuid))) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'request-id-validation')
    }

    if ($rootProperties['operation'].ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
        -Stage 'operation-validation')
    }
    $operation = $rootProperties['operation'].GetString()
    switch -CaseSensitive ($operation) {
      'start' {
        $allowed = @('version', 'requestId', 'operation', 'descriptor')
        $required = @('version', 'requestId', 'operation', 'descriptor')
      }
      'observe' {
        $allowed = @('version', 'requestId', 'operation', 'capsuleId', 'identityAssertion')
        $required = @('version', 'requestId', 'operation', 'capsuleId')
      }
      'stop' {
        $allowed = @('version', 'requestId', 'operation', 'capsuleId', 'identityAssertion', 'timeoutMs')
        $required = @('version', 'requestId', 'operation', 'capsuleId')
      }
      default {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'operation-validation')
      }
    }
    foreach ($propertyName in $rootProperties.Keys) {
      if ($propertyName -cnotin $allowed) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'operation-shape')
      }
    }
    foreach ($requiredName in $required) {
      if (-not $rootProperties.ContainsKey($requiredName)) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'operation-shape')
      }
    }

    $request = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $request.Add('version', $version)
    $request.Add('requestId', $requestId)
    $request.Add('operation', $operation)

    if ($operation -ceq 'start') {
      $descriptorElement = $rootProperties['descriptor']
      if ($descriptorElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidDescriptor' `
          -Stage 'descriptor-validation')
      }
      $descriptor = ConvertFrom-PilotWindowsNativeProcessJsonlElement -Element $descriptorElement
      try { $null = Get-PilotWindowsNativeProcessDescriptor -Descriptor $descriptor } catch {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId (Get-PilotWindowsNativeProcessJsonlSafeValidationErrorId -Exception $_.Exception) `
          -Stage 'descriptor-validation')
      }
      $request.Add('descriptor', $descriptor)
    } else {
      $capsuleElement = $rootProperties['capsuleId']
      if ($capsuleElement.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'capsule-id-validation')
      }
      $capsuleIdText = $capsuleElement.GetString()
      $capsuleIdGuid = [Guid]::Empty
      if (-not (Test-PilotWindowsNativeProcessJsonlGuidD -Value $capsuleIdText -GuidValue ([ref]$capsuleIdGuid))) {
        throw (New-PilotWindowsNativeProcessJsonlException `
          -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidRequest' `
          -Stage 'capsule-id-validation')
      }
      $request.Add('capsuleId', $capsuleIdGuid.ToString('D'))

      if ($rootProperties.ContainsKey('identityAssertion')) {
        $assertionElement = $rootProperties['identityAssertion']
        if ($assertionElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
          throw (New-PilotWindowsNativeProcessJsonlException `
            -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidIdentityAssertion' `
            -Stage 'identity-assertion-validation')
        }
        $assertion = ConvertFrom-PilotWindowsNativeProcessJsonlElement -Element $assertionElement
        try { $null = ConvertTo-PilotWindowsNativeProcessIdentityAssertion -IdentityAssertion $assertion } catch {
          throw (New-PilotWindowsNativeProcessJsonlException `
            -ErrorId (Get-PilotWindowsNativeProcessJsonlSafeValidationErrorId -Exception $_.Exception) `
            -Stage 'identity-assertion-validation')
        }
        $request.Add('identityAssertion', $assertion)
      }

      if ($operation -ceq 'stop' -and $rootProperties.ContainsKey('timeoutMs')) {
        $timeout = [long]0
        if (-not (Test-PilotWindowsNativeProcessJsonlIntegerElement `
            -Element $rootProperties['timeoutMs'] -Minimum 0 -Maximum 120000 -Value ([ref]$timeout))) {
          throw (New-PilotWindowsNativeProcessJsonlException `
            -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidTimeout' `
            -Stage 'timeout-validation')
        }
        try {
          $null = ConvertTo-PilotWindowsNativeProcessStopTimeoutMilliseconds -Value $timeout -WasSpecified $true
        } catch {
          throw (New-PilotWindowsNativeProcessJsonlException `
            -ErrorId (Get-PilotWindowsNativeProcessJsonlSafeValidationErrorId -Exception $_.Exception) `
            -Stage 'timeout-validation')
        }
        $request.Add('timeoutMs', $timeout)
      }
    }

    return [pscustomobject]@{
      Request = $request
      RequestIdGuid = $requestIdGuid
    }
  } finally {
    if ($null -ne $document) { $document.Dispose() }
  }
}

function New-PilotWindowsNativeProcessJsonlReaderContext {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][System.IO.Stream] $Stream,
    [ValidateRange(1, 120000)][int] $FrameTimeoutMilliseconds = 120000
  )

  if (-not $Stream.CanRead) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidReaderContext' `
      -Stage 'reader-initialization')
  }
  return [pscustomobject]@{
    Stream = $Stream
    FrameTimeoutMilliseconds = $FrameTimeoutMilliseconds
    PendingBytes = [System.Collections.Generic.List[byte]]::new()
    RequestIds = [System.Collections.Generic.HashSet[Guid]]::new()
    Eof = $false
    Terminated = $false
    InRead = $false
  }
}

function Read-PilotWindowsNativeProcessJsonlRequest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][object] $ReaderContext)

  if ($null -eq $ReaderContext -or
      $ReaderContext.Stream -isnot [System.IO.Stream] -or
      $ReaderContext.PendingBytes -isnot [System.Collections.Generic.List[byte]] -or
      $ReaderContext.RequestIds -isnot [System.Collections.Generic.HashSet[Guid]] -or
      $ReaderContext.FrameTimeoutMilliseconds -lt 1 -or
      $ReaderContext.FrameTimeoutMilliseconds -gt 120000) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidReaderContext' `
      -Stage 'reader-state')
  }
  if ($ReaderContext.InRead) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.ReaderTerminated' `
      -Stage 'reader-concurrency')
  }
  if ($ReaderContext.Eof) { return $null }
  if ($ReaderContext.Terminated) {
    throw (New-PilotWindowsNativeProcessJsonlException `
      -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.ReaderTerminated' `
      -Stage 'reader-state')
  }

  $ReaderContext.InRead = $true
  try {
    $frameResult = Read-PilotWindowsNativeProcessJsonlFrame -ReaderContext $ReaderContext
    if ($null -eq $frameResult) { return $null }
    $frameBytes = [byte[]]$frameResult.Bytes
    if ($frameBytes.Length -ge 3 -and
        $frameBytes[0] -eq 239 -and $frameBytes[1] -eq 187 -and $frameBytes[2] -eq 191) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.BomNotAllowed' `
        -Stage 'utf8-bom')
    }

    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try { $frameText = $utf8.GetString($frameBytes) } catch {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.InvalidEncoding' `
        -Stage 'utf8-decode')
    }
    $parsed = ConvertFrom-PilotWindowsNativeProcessJsonlRequest -FrameText $frameText

    if ($ReaderContext.RequestIds.Contains([Guid]$parsed.RequestIdGuid)) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.DuplicateRequestId' `
        -Stage 'request-id-replay')
    }
    if ($ReaderContext.RequestIds.Count -ge 4096) {
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.RequestIdCapacityExceeded' `
        -Stage 'request-id-capacity')
    }
    [void]$ReaderContext.RequestIds.Add([Guid]$parsed.RequestIdGuid)
    return ,$parsed.Request
  } catch {
    $jsonlErrorId = Get-PilotWindowsNativeProcessJsonlErrorId -Exception $_.Exception
    if ([string]::IsNullOrEmpty($jsonlErrorId)) {
      $ReaderContext.Terminated = $true
      throw (New-PilotWindowsNativeProcessJsonlException `
        -ErrorId 'Morrow.WindowsNativeProcess.Jsonl.ReadFailed' `
        -Stage 'request-reader')
    }
    $ReaderContext.Terminated = $true
    throw
  } finally {
    $ReaderContext.InRead = $false
  }
}
