# Fails the job if any Windows binary the release just built is not
# Authenticode-signed with a valid signature. Runs only when signing is on.
#
# This is a backstop, not the gate: tauri-action has already uploaded by the time
# it runs. The gate is the signCommand itself, which fails `tauri build` (before
# any upload) when signing errors. This catches the case where the overlay never
# reached the build at all, so an unsigned installer does not go unnoticed.
$ErrorActionPreference = 'Stop'

$release = 'app/apps/desktop/src-tauri/target/release'
$files = @(
  Get-ChildItem "$release/bundle/nsis/*.exe" -ErrorAction SilentlyContinue
  Get-ChildItem "$release/bundle/msi/*.msi" -ErrorAction SilentlyContinue
  Get-ChildItem "$release/*.exe" -ErrorAction SilentlyContinue
)
if ($files.Count -eq 0) { throw "No Windows binaries found under $release" }

$bad = 0
foreach ($f in $files) {
  $sig = Get-AuthenticodeSignature -FilePath $f.FullName
  $subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '-' }
  Write-Output ("{0,-10} {1}  [{2}]" -f $sig.Status, $f.Name, $subject)
  if ($sig.Status -ne 'Valid') { $bad++ }
}
if ($bad -gt 0) {
  Write-Output "::error title=Unsigned Windows binaries::$bad of $($files.Count) files are not validly signed."
  exit 1
}
