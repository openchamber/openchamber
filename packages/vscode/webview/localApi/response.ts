export const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

export const unsupportedWebRouteResponse = (feature: string): Response => {
  return jsonResponse({ error: `${feature} is not supported in VS Code` }, 501);
};

export const pluginConfigErrorStatus = (message: string): number => {
  const lower = message.toLowerCase();
  if (lower.includes('already exists')) return 409;
  if (lower.includes('not found')) return 404;
  if (lower.includes('required') || lower.includes('invalid') || lower.includes('must ')) return 400;
  return 500;
};
