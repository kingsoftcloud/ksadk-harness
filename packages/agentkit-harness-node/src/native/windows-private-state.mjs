import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Windows mode bits and uid do not describe NTFS access. Resolve security
// identifiers directly so the check does not depend on localized account names.
const checkAcl = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
$acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $env:AGENTKIT_WINDOWS_PRIVATE_STATE_PATH
if ($acl.GetOwner($sidType).Value -notin $trusted) { exit 2 }
foreach ($entry in $acl.GetAccessRules($true, $true, $sidType)) {
  if ($entry.AccessControlType -ne 'Allow') { continue }
  $principal = $entry.IdentityReference.Value
  if ($principal -in $trusted) { continue }
  $inheritOnly = $entry.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly
  if ($principal -eq 'S-1-3-0' -and $inheritOnly) { continue }
  exit 2
}
`, 'utf16le').toString('base64');

const verified = new Map();

export function verifyWindowsPrivateState(path, stat) {
  const identity = [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs].join(':');
  if (verified.get(path) === identity) return true;
  const root = process.env.SystemRoot;
  if (!root) return false;
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', checkAcl], {
    env: { SystemRoot: root, AGENTKIT_WINDOWS_PRIVATE_STATE_PATH: path },
    stdio: 'ignore', windowsHide: true, timeout: 5000,
  });
  if (result.status !== 0 || result.error) return false;
  // Only the accepted principals can change an accepted ACL. File replacement
  // or metadata changes require a fresh check.
  if (verified.size >= 1024) verified.clear();
  verified.set(path, identity);
  return true;
}
