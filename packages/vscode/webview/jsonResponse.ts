export const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
