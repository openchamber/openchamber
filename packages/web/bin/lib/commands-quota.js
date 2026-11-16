import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { isJsonMode, isQuietMode, printJson } from '../cli-output.js';
import { asNonEmptyString } from '../../server/lib/shared/guards.js';


// A whole number from the environment, else null. Only a plain decimal
// spelling counts: a bare parseInt would read '1e3' as 1, '4096junk' as
// 4096, and '10.9' as 10. Same strict judgement as parsePlainDecimalInt in
// server/lib/fs/routes.js and the whole-text checks in cli-args.js.
const parsePlainDecimalInt = (raw) => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

const QUOTA_HELP = `OpenChamber Quota Commands

USAGE:
  openchamber quota [PROVIDER ...] [OPTIONS]

  Without a PROVIDER, prints every provider with a usable credential.
  Providers OpenCode has turned off (disabled_providers) are left out;
  --all includes them.
  With one or more PROVIDER arguments, prints those providers in the
  order given. An argument may be a provider id (codex), its display
  name (Codex), or one of its credential aliases (chatgpt, copilot);
  matching ignores case. A provider named exactly this way is always
  fetched, even one OpenCode has turned off.
  An argument containing * or ? is a pattern. It expands, in catalogue
  order, to every configured provider whose id, display name, or alias
  matches, still leaving out turned off providers unless --all is set.
  An argument that resolves to nothing is a usage error.
  A provider with several stored credentials prints one block per
  credential, labeled with the credential and the account it metered.
  Quota is read from OpenCode's credential store on this machine,
  directly — the same direct store read the aggregator gatherer uses
  (code#2490's single source) — so the CLI and the gatherer resolve
  the same credentials the same way. Every result names that source
  (credentialSource: local in --json), and one provider's failure or
  timeout never hides the rest.

OUTPUT OPTIONS:
  --all                   Include providers OpenCode has turned off
  --json                  Output machine-readable JSON
  -q, --quiet             One compact line per credential

  The exit code is non-zero when a requested provider returned no
  successful result at all.

ENVIRONMENT:
  OPENCHAMBER_QUOTA_TIMEOUT_MS    Per-provider fetch timeout in milliseconds (default: 10000)
`;

const formatWindowValue = (window) => {
  if (Number.isFinite(window?.usedPercent)) {
    return `${window.usedPercent}% used`;
  }
  return asNonEmptyString(window?.valueLabel) ?? 'unknown';
};

const formatResultHeader = (result) => {
  const parts = [`${result.providerName} (${result.providerId})`];
  const credentialLabel = asNonEmptyString(result.credentialLabel);
  if (credentialLabel) {
    parts.push(credentialLabel);
  }
  const accountLabel = asNonEmptyString(result.accountLabel);
  if (accountLabel) {
    parts.push(accountLabel);
  }
  return parts.join(' — ');
};

const formatQuotaResultLines = (result) => {
  const header = formatResultHeader(result);
  if (!result.ok) {
    return [`${header}: ${result.error ?? 'Failed to fetch quota'}`];
  }
  const entries = Object.entries(result.usage?.windows ?? {});
  if (entries.length === 0) {
    return [`${header}: no usage windows reported`];
  }
  const lines = [header];
  for (const [label, window] of entries) {
    const resetAtFormatted = asNonEmptyString(window?.resetAtFormatted);
    const reset = resetAtFormatted ? `, resets ${resetAtFormatted}` : '';
    lines.push(`  ${label}: ${formatWindowValue(window)}${reset}`);
  }
  lines.push(...formatModelBreakdownLines(result.usage?.models));
  return lines;
};

const formatAmount = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));

// Per-model detail a provider attached to the result (Open Design usage
// records), printed as an indented block under the provider's windows. Each
// segment appears only when the provider reported that field.
const formatModelBreakdownLines = (models) => {
  if (!Array.isArray(models) || models.length === 0) {
    return [];
  }
  const lines = ['  models:'];
  for (const entry of models) {
    const segments = [];
    if (Number.isFinite(entry?.credits)) segments.push(`${formatAmount(entry.credits)} credits`);
    if (Number.isFinite(entry?.sharePercent)) segments.push(`${formatAmount(entry.sharePercent)}% share`);
    if (Number.isFinite(entry?.totalTokens) && entry.totalTokens > 0) segments.push(`${entry.totalTokens} tokens`);
    if (Number.isFinite(entry?.multiplier)) segments.push(`${formatAmount(entry.multiplier)}x multiplier`);
    const model = asNonEmptyString(entry?.model) ?? 'unknown model';
    lines.push(segments.length > 0 ? `    ${model}: ${segments.join(', ')}` : `    ${model}`);
  }
  return lines;
};

const formatQuotaQuietLine = (result) => {
  const credentialLabel = asNonEmptyString(result.credentialLabel);
  const head = credentialLabel
    ? `${result.providerId}/${credentialLabel.replace(/\s+/g, '-')}`
    : result.providerId;
  if (!result.ok) {
    return `${head} error`;
  }
  const tokens = Object.entries(result.usage?.windows ?? {}).map(([label, window]) => {
    if (Number.isFinite(window?.usedPercent)) {
      return `${label}:${window.usedPercent}%`;
    }
    const valueLabel = asNonEmptyString(window?.valueLabel);
    return valueLabel ? `${label}:${valueLabel}` : `${label}:unknown`;
  });
  return [head, ...tokens].join(' ');
};

const defaultLoadQuotaRuntime = async () => {
  const [authModule, quotaModule] = await Promise.all([
    import('../../server/lib/opencode/auth.js'),
    import('../../server/lib/quota/index.js'),
  ]);
  return {
    configureOpenCodeCredentials: authModule.configureOpenCodeCredentials,
    openCodeLocalCredentialSource: authModule.openCodeLocalCredentialSource,
    listConfiguredQuotaProviders: quotaModule.listConfiguredQuotaProviders,
    listQuotaProviderCatalogue: quotaModule.listQuotaProviderCatalogue,
    fetchQuotaForProviderInstances: quotaModule.fetchQuotaForProviderInstances,
  };
};

const QUOTA_FETCH_CONCURRENCY = 6;
const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;

const resolveQuotaTimeoutMs = (env) => {
  const parsed = parsePlainDecimalInt(env.OPENCHAMBER_QUOTA_TIMEOUT_MS);
  // The value feeds setTimeout, which cannot honour more than 2^31-1 ms: a
  // larger duration overflows to ~1 ms and every fetch instantly 'times out'.
  // Fall back to the default instead, the bound createGitExecTimeoutMs uses.
  return parsed !== null && parsed > 0 && parsed <= 2_147_483_647 ? parsed : DEFAULT_QUOTA_TIMEOUT_MS;
};

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
};

/**
 * One provider's results with its elapsed time attached. A provider that
 * outlives the timeout answers a `status: 'timeout'` row instead of
 * holding the whole run; a dispatcher throw answers an error row for
 * that provider alone. Either way the batch completes.
 */
const fetchProviderWithTimeout = async (runtime, providerId, providerName, timeoutMs) => {
  const startedAt = Date.now();
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const results = await Promise.race([runtime.fetchQuotaForProviderInstances(providerId), deadline]);
    if (results === null) {
      return [{
        providerId,
        providerName,
        ok: false,
        configured: true,
        usage: null,
        error: `Quota fetch timed out after ${timeoutMs} ms`,
        status: 'timeout',
        fetchedAt: startedAt,
        elapsedMs: Date.now() - startedAt,
      }];
    }
    const elapsedMs = Date.now() - startedAt;
    return results.map((result) => ({ ...result, elapsedMs }));
  } catch (error) {
    return [{
      providerId,
      providerName,
      ok: false,
      configured: true,
      usage: null,
      error: error instanceof Error ? error.message : 'Request failed',
      fetchedAt: startedAt,
      elapsedMs: Date.now() - startedAt,
    }];
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const fetchProviders = async (runtime, providerIds, catalogue, timeoutMs) => {
  const nameById = new Map(catalogue.map((entry) => [entry.id, entry.name]));
  const groups = await mapWithConcurrency(providerIds, QUOTA_FETCH_CONCURRENCY, (id) =>
    fetchProviderWithTimeout(runtime, id, nameById.get(id) ?? id, timeoutMs));
  return groups.flat();
};

const hasWildcard = (token) => token.includes('*') || token.includes('?');

const escapeRegExpChar = (char) => ('.*+^${}()|[]\\'.includes(char) ? `\\${char}` : char);

const wildcardToRegExp = (pattern) => new RegExp(
  `^${[...pattern].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExpChar(char))).join('')}$`,
  'i'
);

/**
 * Resolve one run's provider arguments to provider ids, in argument
 * order, duplicates removed. An argument without wildcard characters
 * resolves exactly (provider id, then display name, then credential
 * alias; matching ignores case) and is explicit: it is fetched even when
 * the provider is turned off or holds no credential. A wildcard pattern
 * expands, in catalogue order, over the configured providers only, and
 * leaves out the turned off ones unless `includeDisabled` is set. An
 * argument that resolves to nothing throws a usage error before anything
 * is fetched.
 */
const resolveQuotaProviderArgs = ({ args, catalogue, configuredIds, includeDisabled }) => {
  const resolved = [];
  const seen = new Set();
  const push = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  };

  for (const arg of args) {
    if (hasWildcard(arg)) {
      const matcher = wildcardToRegExp(arg);
      const matches = catalogue.filter((entry) => configuredIds.has(entry.id)
        && (includeDisabled || !entry.disabled)
        && (matcher.test(entry.id) || matcher.test(entry.name) || entry.aliases.some((alias) => matcher.test(alias))));
      if (matches.length === 0) {
        throw new TunnelCliError(`No configured quota provider matches '${arg}'.`, EXIT_CODE.USAGE_ERROR);
      }
      for (const entry of matches) push(entry.id);
      continue;
    }
    const needle = arg.toLowerCase();
    const exact = catalogue.find((entry) => entry.id.toLowerCase() === needle)
      ?? catalogue.find((entry) => entry.name.toLowerCase() === needle)
      ?? catalogue.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === needle));
    if (!exact) {
      throw new TunnelCliError(`Unknown quota provider '${arg}'.`, EXIT_CODE.USAGE_ERROR);
    }
    push(exact.id);
  }
  return resolved;
};

const normalizeProviderArgs = (providerArg) => {
  if (Array.isArray(providerArg)) {
    return providerArg.flatMap((token) => {
      const value = asNonEmptyString(token);
      return value ? [value] : [];
    });
  }
  const single = asNonEmptyString(providerArg);
  return single ? [single] : [];
};

function createQuotaCommand({ loadQuotaRuntime = defaultLoadQuotaRuntime, env = process.env } = {}) {
  return async function quotaCommand(options = {}, providerArg = null) {
    const args = normalizeProviderArgs(providerArg);
    if (args.length === 1 && args[0] === 'help') {
      process.stdout.write(QUOTA_HELP);
      return;
    }

    const runtime = await loadQuotaRuntime();
    // The single credential source (code#2490, openchamber #2282):
    // OpenCode's credential store read directly from its database —
    // the same read the aggregator gatherer performs — with no
    // server round-trip and no server-first/store-fallback split, so
    // this CLI cannot diverge from the gatherer about which
    // credentials exist. The servedBy()/local reporting collapses
    // accordingly: every read is a store read, stamped
    // credentialSource 'local' below, and the help text says so —
    // there is no server read left to mistake it for.
    const credentialSource = runtime.openCodeLocalCredentialSource();
    runtime.configureOpenCodeCredentials(credentialSource);
    const timeoutMs = resolveQuotaTimeoutMs(env);

    let results;
    let requestedIds = null;
    if (args.length > 0) {
      const catalogue = await runtime.listQuotaProviderCatalogue();
      const configured = await runtime.listConfiguredQuotaProviders({ includeDisabled: true });
      requestedIds = resolveQuotaProviderArgs({
        args,
        catalogue,
        configuredIds: new Set(configured),
        includeDisabled: Boolean(options.all),
      });
      results = await fetchProviders(runtime, requestedIds, catalogue, timeoutMs);
    } else {
      const configured = await runtime.listConfiguredQuotaProviders({ includeDisabled: Boolean(options.all) });
      const catalogue = await runtime.listQuotaProviderCatalogue();
      results = await fetchProviders(runtime, configured, catalogue, timeoutMs);
    }

    results = results.map((result) => ({ ...result, credentialSource: 'local' }));

    if (isJsonMode(options)) {
      printJson({ providers: results });
    } else if (isQuietMode(options)) {
      if (results.length === 0) {
        process.stdout.write('none configured\n');
      } else {
        for (const result of results) {
          process.stdout.write(`${formatQuotaQuietLine(result)}\n`);
        }
      }
    } else if (results.length === 0) {
      process.stdout.write('No quota providers configured.\n');
    } else {
      process.stdout.write(`${results.flatMap(formatQuotaResultLines).join('\n')}\n`);
    }

    if (requestedIds && requestedIds.some((id) => !results.some((result) => result.providerId === id && result.ok))) {
      process.exitCode = EXIT_CODE.GENERAL_ERROR;
    }
  };
}

export {
  createQuotaCommand,
  formatQuotaResultLines,
  formatQuotaQuietLine,
  resolveQuotaTimeoutMs,
};
