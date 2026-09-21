type OllamaWindow = { usedPercent: number | null; valueLabel?: string };
type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

export const fetchOllamaUsage = async (cookie: string, fetchImpl: OllamaFetch = fetch) => {
  const response = await fetchImpl('https://ollama.com/settings', {
    method: 'GET',
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Ollama Cloud authentication failed');

  const html = await response.text();
  const windows: Record<string, OllamaWindow> = {};
  for (const [key, pattern] of [
    ['session', /Session\s+usage[^0-9]*([0-9.]+)%/i],
    ['weekly', /Weekly\s+usage[^0-9]*([0-9.]+)%/i],
  ] as const) {
    const match = html.match(pattern);
    if (!match) continue;
    const usedPercent = Number(match[1]);
    if (Number.isFinite(usedPercent)) {
      windows[key] = { usedPercent };
    }
  }

  const premium = html.match(/Premium[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  if (premium) {
    const used = Number(premium[1]);
    const total = Number(premium[2]);
    if (Number.isFinite(used) && Number.isFinite(total)) {
      windows.premium = {
        usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : null,
        valueLabel: `${used} / ${total}`,
      };
    }
  }

  const monthly = html.match(/Monthly\s+usage[\s\S]{0,200}?\$([0-9][0-9,.]*)\s+of\s+\$([0-9][0-9,.]*)/i);
  if (monthly) {
    const used = Number(monthly[1].replace(/,/g, ''));
    const total = Number(monthly[2].replace(/,/g, ''));
    if (Number.isFinite(used) && Number.isFinite(total)) {
      windows.monthly = {
        usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : null,
        valueLabel: `$${monthly[1]} / $${monthly[2]}`,
      };
    }
  }

  // Anchor on the balance label, not nearby purchase or auto-reload amounts.
  const balanceMatch = html.match(/Balance\s+remaining[\s\S]{0,200}?\$([0-9][0-9,.]*)/i);
  if (balanceMatch) {
    const balance = Number(balanceMatch[1].replace(/,/g, ''));
    if (Number.isFinite(balance) && balance > 0) {
      windows.credits_balance = { usedPercent: null, valueLabel: `$${balanceMatch[1]}` };
    }
  }
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};
