param(
  [Parameter(Mandatory=$true)][string]$Apk,
  [Parameter(Mandatory=$true)][string]$Acceptance,
  [Parameter(Mandatory=$true)][string]$Out
)
$ErrorActionPreference='Stop'
function FileSha([string]$Path) {
  $sha=[Security.Cryptography.SHA256]::Create()
  $stream=[IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
$project=Split-Path $PSScriptRoot -Parent
$workspace=Split-Path (Split-Path $project -Parent) -Parent
$sdk=Join-Path $workspace 'android-sdk'
$jdk='C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot'
$tools=Join-Path $sdk 'build-tools\36.0.0'
$inputApk=[IO.Path]::GetFullPath($Apk)
$target=[IO.Path]::GetFullPath($Out)
if (!(Test-Path -LiteralPath $inputApk -PathType Leaf)) { throw 'Independent APK does not exist' }
if (Test-Path -LiteralPath $target) { throw 'Refusing to overwrite an existing release artifact' }
if (Test-Path -LiteralPath ($target+'.sha256')) { throw 'Refusing to overwrite an existing release checksum' }
$proof=Get-Content -LiteralPath $Acceptance -Raw -Encoding UTF8 | ConvertFrom-Json
$hash=FileSha $inputApk
if ($proof.status -ne 'passed' -or $proof.baseline -ne 2581 -or $proof.apkSHA256 -ne $hash -or
    $proof.fullCoveragePassed -ne $true -or $proof.fullFlowPassed -ne $true -or
    $proof.offlineCorePassed -ne $true -or $proof.offlineContinuousSeconds -lt 3600) {
  throw 'Final signing requires matching complete coverage, flow and at least 60 minutes of continuous offline acceptance'
}
$aapt=Join-Path $tools 'aapt.exe'
$badging=& $aapt dump badging $inputApk
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify independent APK metadata' }
$metadata=$badging -join "`n"
if ($metadata -notmatch "package: name='org\.stormcaravan\.alloy2581'" -or
    $metadata -notmatch "(?m)^native-code: 'arm64-v8a'[ \t]*$" -or $metadata -match 'application-debuggable:') {
  throw 'Final signing only accepts the independent non-debuggable arm64-only package'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($inputApk)
try {
  if (!$archive.GetEntry('assets/alloy/bootstrap.js') -or !$archive.GetEntry('lib/arm64-v8a/liballoy2581.so')) {
    throw 'Independent native host and game entry are required; original APK resigning is not supported'
  }
} finally { $archive.Dispose() }
$secure=Join-Path $HOME '.omp\agent\credentials\storm-caravan'
$store=Join-Path $secure 'release.p12'
Add-Type -AssemblyName System.Security
$encryptedHex=[IO.File]::ReadAllText((Join-Path $secure 'password.dpapi')).Trim()
$encryptedBytes=New-Object byte[] ($encryptedHex.Length / 2)
for ($i=0; $i -lt $encryptedBytes.Length; $i++) {
  $encryptedBytes[$i]=[Convert]::ToByte($encryptedHex.Substring($i*2,2),16)
}
$passwordBytes=[Security.Cryptography.ProtectedData]::Unprotect($encryptedBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
  $env:STORM_CARAVAN_STORE_PASS=[Text.Encoding]::Unicode.GetString($passwordBytes)
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  $signer=Join-Path $tools 'lib\apksigner.jar'
  $java=Join-Path $jdk 'bin\java.exe'
  & $java -jar $signer sign --ks $store --ks-key-alias 'storm-caravan' --ks-pass 'env:STORM_CARAVAN_STORE_PASS' --key-pass 'env:STORM_CARAVAN_STORE_PASS' --out $target $inputApk
  if ($LASTEXITCODE -ne 0) { throw 'Native APK production signing failed' }
  & $java -jar $signer verify --verbose $target
  if ($LASTEXITCODE -ne 0) { throw 'Native APK production signature verification failed' }
  $signedHash=FileSha $target
  [IO.File]::WriteAllText(($target+'.sha256'),($signedHash+'  '+[IO.Path]::GetFileName($target)+"`n"))
  Write-Output ('SHA256 '+$signedHash+'  '+$target)
} finally {
  [Array]::Clear($passwordBytes,0,$passwordBytes.Length)
  [Array]::Clear($encryptedBytes,0,$encryptedBytes.Length)
  Remove-Item Env:STORM_CARAVAN_STORE_PASS -ErrorAction SilentlyContinue
}
