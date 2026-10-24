import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { asNonEmptyString } from '../../utils/transformers.js';

// agy 1.3.5 uses go-keyring's generic gemini:antigravity target with UTF-8 JSON.
const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgyCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void Free(IntPtr credential);
  public static byte[] ReadBlob() {
    IntPtr pointer;
    if (!Read("gemini:antigravity", 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new Exception("Credential read failed");
    }
    try {
      var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 2560) throw new Exception("Invalid credential size");
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return bytes;
    } finally { Free(pointer); }
  }
}
'@
$bytes = [AgyCredential]::ReadBlob()
if ($null -eq $bytes) { [Console]::Out.Write('absent') }
else { [Console]::Out.Write('credential:' + [Convert]::ToBase64String($bytes)) }
} catch { exit 2 }
`;

const readWindowsCredential = (env) => {
  if (!env.SystemRoot) return null;
  try {
    const output = execFileSync(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(credentialScript, 'utf16le').toString('base64')
    ], { env, windowsHide: true, timeout: 10000, maxBuffer: 16384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const result = output.trim();
    // Only CredReadW's ERROR_NOT_FOUND permits a different credential source.
    if (result === 'absent') return undefined;
    if (!result.startsWith('credential:')) return null;
    const encoded = result.slice('credential:'.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 2560 || bytes.toString('base64') !== encoded) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const parseCredential = (raw) => {
  try {
    const data = JSON.parse(raw);
    if (!data || Array.isArray(data) || typeof data !== 'object') return null;
    if (data.auth_method && !['consumer', 'oauth-personal'].includes(data.auth_method)) return null;
    const refreshToken = asNonEmptyString(data.token?.refresh_token);
    return refreshToken ? { sourceId: 'antigravity-cli', sourceLabel: 'Antigravity CLI', refreshToken } : null;
  } catch {
    // JSON parser errors can contain credential text. Never log them.
    return null;
  }
};

/** Read only the CLI's personal login. A redirected home never borrows the native login. */
export const resolveCliAuth = ({ env = process.env, platform = process.platform, nativeHome = homedir(), readKeyring = readWindowsCredential, readFile = readFileSync } = {}) => {
  const home = asNonEmptyString(env.GEMINI_HOME) ?? join(asNonEmptyString(env.HOME) ?? nativeHome, '.gemini');
  const defaultHome = resolve(home) === resolve(join(nativeHome, '.gemini')) &&
    (!asNonEmptyString(env.HOME) || resolve(env.HOME.trim()) === resolve(nativeHome));
  if (platform === 'win32' && defaultHome) {
    const raw = readKeyring(env);
    if (raw !== undefined) return parseCredential(raw);
  }
  try {
    return parseCredential(readFile(join(home, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'));
  } catch {
    return null;
  }
};
