/**
 * Reproduction script for Issue #2187
 * 
 * "Ollama Cloud Usage Not Working Despite Of The Setup Of ollama API"
 * 
 * This script reproduces the exact code path that leads to the
 * "Provider not configured" error when viewing Ollama Cloud usage.
 * 
 * It simulates the complete flow from UI to server:
 * 1. Credential save validation (PUT /api/quota/credentials/ollama-cloud)
 * 2. Credential read (readManagedCredential)
 * 3. Quota fetch (fetchQuota → fetchOllamaCloudUsage)
 * 
 * The issue is that:
 * - The user expects their local Ollama API setup to enable cloud usage tracking
 * - Ollama Cloud requires a separate ollama.com session cookie
 * - The credential validation requires ollama.com to accept the cookie
 * - If the cookie is missing/invalid, ollama.com returns 303 → /signin
 * - The redirect: 'manual' setting catches this as authentication failure
 * - The credential is never saved, leading to "Provider not configured"
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================
// Simulate the credential store (packages/web/server/lib/quota/credentials/store.js)
// ============================================================
const MANAGED_QUOTA_PROVIDERS = new Set(['opencode-go', 'ollama-cloud', 'cursor']);

const getCredentialsDir = () => join(tmpdir(), 'openchamber-repro-' + randomUUID());

let credentialsDir = getCredentialsDir();

const credentialPath = (providerId) => {
  if (!MANAGED_QUOTA_PROVIDERS.has(providerId)) throw new Error('Unsupported credential provider');
  return join(credentialsDir, `${providerId}.json`);
};

const readQuotaCredential = (providerId, normalize) => {
  try {
    return normalize(JSON.parse(readFileSync(credentialPath(providerId), 'utf8')));
  } catch (error) {
    return null;
  }
};

const writeQuotaCredential = (providerId, credential) => {
  const target = credentialPath(providerId);
  const directory = join(credentialsDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(target, JSON.stringify(credential, null, 2) + '\n');
};

// ============================================================
// Simulate the normalizer (packages/web/server/lib/quota/credentials/providers.js)
// ============================================================
const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

const normalizers = {
  'ollama-cloud': (value) => {
    const cookie = clean(value?.cookie);
    return cookie ? { cookie } : null;
  },
};

const readManagedCredential = (providerId) => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

// ============================================================
// Simulate the quota fetch (packages/web/server/lib/quota/providers/ollama-cloud.js)
// ============================================================
const buildResult = (partial) => ({
  providerId: partial.providerId,
  providerName: partial.providerName,
  ok: partial.ok ?? false,
  configured: partial.configured ?? false,
  error: partial.error ?? null,
  usage: partial.usage ?? null,
  fetchedAt: Date.now(),
});

const toNumber = (v) => (v !== null && v !== undefined && v !== '' ? Number(v) : null);
const toUsageWindow = (opts) => ({
  usedPercent: opts.usedPercent,
  maxPercent: opts.maxPercent ?? 100,
  windowSeconds: opts.windowSeconds,
  resetAt: opts.resetAt,
  valueLabel: opts.valueLabel ?? null,
});

const parseOllamaSettingsHtml = (html) => {
  const windows = {};
  const sessionMatch = html.match(/Session\s+usage[^0-9]*([0-9.]+)%/i);
  if (sessionMatch) {
    windows.session = toUsageWindow({ usedPercent: toNumber(sessionMatch[1]), windowSeconds: null, resetAt: null });
  }
  const weeklyMatch = html.match(/Weekly\s+usage[^0-9]*([0-9.]+)%/i);
  if (weeklyMatch) {
    windows.weekly = toUsageWindow({ usedPercent: toNumber(weeklyMatch[1]), windowSeconds: null, resetAt: null });
  }
  const premiumMatch = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premiumMatch) {
    const used = toNumber(premiumMatch[1]);
    const total = toNumber(premiumMatch[2]);
    const usedPercent = total && used !== null ? Math.min(100, (used / total) * 100) : null;
    windows.premium = toUsageWindow({ usedPercent, windowSeconds: null, resetAt: null, valueLabel: `${used ?? 0} / ${total ?? 0}` });
  }
  return windows;
};

const fetchOllamaCloudUsage = async (credential, fetchImpl = fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: { Cookie: credential.cookie, 'User-Agent': 'OpenChamber quota provider' },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);
  const windows = parseOllamaSettingsHtml(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

const fetchQuota = async () => {
  const credential = readManagedCredential('ollama-cloud');

  if (!credential) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const windows = await fetchOllamaCloudUsage(credential);
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId: 'ollama-cloud',
      providerName: 'Ollama Cloud',
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

// ============================================================
// TEST: Reproduce "Provider not configured" 
// ============================================================
console.log('=' .repeat(72));
console.log('REPRODUCTION OF ISSUE #2187');
console.log('=' .repeat(72));

// Reset credentials
credentialsDir = getCredentialsDir();

// STEP 1: No credential saved (simulates user who only configured local Ollama API)
console.log('\n[STEP 1] Fetch quota WITHOUT any credential saved');
console.log('   (This simulates a user who has set up their local Ollama API');
console.log('    but has NOT entered an ollama.com session cookie)');
console.log('-'.repeat(72));

const result = await fetchQuota();
console.log(`   result.configured: ${result.configured}`);
console.log(`   result.error: ${result.error}`);
console.log(`   result.ok: ${result.ok}`);

if (!result.configured && result.error === 'Not configured') {
  console.log('\n  ✅ BUG REPRODUCED: "Provider not configured" shown to user!');
  console.log('  The UI renders:');
  console.log('    "Provider not configured"');
  console.log('    "Add credentials in the Providers tab to enable usage tracking."');
}

// STEP 2: Show the credential save path would also fail
console.log('\n[STEP 2] Demonstrate that credential save validation requires ollama.com');
console.log('   When user clicks Save in Providers tab, the validator calls');
console.log('   fetchOllamaCloudUsage which hits ollama.com/settings.');
console.log('   Without a valid session cookie, ollama.com returns 303 → /signin.');
console.log('-'.repeat(72));

try {
  await fetchOllamaCloudUsage({ cookie: 'session=test_cookie' });
} catch (err) {
  console.log(`   Validation error: ${err.message}`);
  console.log('  ✅ This shows credential save would also fail without a valid cookie');
}

// STEP 3: What the server actual response looks like
console.log('\n[STEP 3] Actual HTTP behavior of ollama.com/settings');
console.log('-'.repeat(72));

try {
  const response = await fetch('https://ollama.com/settings', {
    method: 'GET',
    headers: { 'User-Agent': 'OpenChamber quota provider' },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  console.log(`   Status: ${response.status}`);
  console.log(`   Location: ${response.headers.get('location') || '(none)'}`);
  console.log(`   (ollama.com redirects to /signin when no valid cookie is present)`);
} catch (e) {
  console.log(`   Fetch error: ${e.message}`);
}

// ============================================================
// SUMMARY
// ============================================================
console.log('\n' + '=' .repeat(72));
console.log('ROOT CAUSE SUMMARY');
console.log('=' .repeat(72));
console.log(`
1. The user configured the local Ollama API (model provider in OpenChamber)
2. The "Ollama Cloud" usage tracking in the Usage page shows "Provider not configured"
3. This happens because:
   - "Ollama" (local model server) and "Ollama Cloud" (ollama.com usage tracking) 
     are SEPARATE systems
   - Ollama Cloud usage tracking requires a session cookie from ollama.com
   - The cookie is validated by fetching https://ollama.com/settings
   - Without a valid cookie, ollama.com returns 303 → /signin
   - The validation treats this redirect as authentication failure
   - The credential is never saved → readManagedCredential returns null
   - fetchQuota returns { configured: false } → "Provider not configured"

4. Additional UX confusion:
   - The Providers page shows the "Ollama Cloud" credential section when
     the user selects the local "Ollama" provider (line 951 of ProvidersPage.tsx)
   - This makes users think their local Ollama API setup enables cloud usage tracking
`);
