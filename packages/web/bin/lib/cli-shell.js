// Replay commands target PowerShell on Windows and POSIX shells elsewhere.
export const shellQuote = (value, platform = process.platform) => {
  const text = String(value);
  if (/^[A-Za-z0-9._\-/:=]+$/.test(text)) return text;
  return `'${text.replaceAll("'", platform === 'win32' ? "''" : "'\"'\"'")}'`;
};
