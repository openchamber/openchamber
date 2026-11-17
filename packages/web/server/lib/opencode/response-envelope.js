export const unwrapOpenCodeResponse = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return 'data' in body && !('cursor' in body) ? body.data : body;
};
