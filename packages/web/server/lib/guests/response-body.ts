export type BoundedResponseText = { tooLarge: false; text: string } | { tooLarge: true };

export const readBoundedResponseText = async (response: Response, maxBytes: number): Promise<BoundedResponseText> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { tooLarge: false, text: '' };
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  return { tooLarge: false, text: Buffer.concat(chunks, size).toString('utf8') };
};
