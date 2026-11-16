export const guestFramePolicy = (connectSource: string | null, origins: readonly string[] = []): string => {
  const approved = origins.length > 0 ? ` ${origins.join(' ')}` : '';
  const local = "'self' data: blob:";
  const connect = [connectSource, ...origins].filter((source): source is string => Boolean(source));
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${local}`,
    `style-src 'unsafe-inline' ${local}${approved}`,
    `img-src ${local}${approved}`,
    `font-src ${local}${approved}`,
    `media-src ${local}${approved}`,
    `worker-src ${local}`,
    `frame-src ${local}`,
    `connect-src ${connect.length > 0 ? connect.join(' ') : "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
};
