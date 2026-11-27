const IMF_FIXDATE_LENGTH = 29;

export function retryAfterAt(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const at = new Date(now + Number(value) * 1000).getTime();
    return Number.isFinite(at) ? at : undefined;
  }
  if (value.length !== IMF_FIXDATE_LENGTH) return undefined;
  const date = new Date(value);
  const at = date.getTime();
  return at > now && date.toUTCString() === value ? at : undefined;
}
