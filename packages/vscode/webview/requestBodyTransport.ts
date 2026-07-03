const encodeBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

export const hasInitBody = (init: RequestInit | undefined): boolean => init?.body !== undefined && init.body !== null;

const readBodyBytes = async (body: BodyInit): Promise<Uint8Array> => {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }

  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }

  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof FormData) {
    return new Uint8Array(await new Request('https://openchamber.local/body', { method: 'POST', body }).arrayBuffer());
  }

  throw new Error('Unsupported request body type');
};

const readBodyText = async (body: BodyInit): Promise<string> => {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return await body.text();
  return new TextDecoder().decode(await readBodyBytes(body));
};

export const extractBodyBase64 = async (input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<string | undefined> => {
  if (method === 'GET' || method === 'HEAD') return undefined;

  if (input instanceof Request && !hasInitBody(init)) {
    const cloned = input.clone();
    const buffer = await cloned.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return bytes.length > 0 ? encodeBase64(bytes) : undefined;
  }

  const body = init?.body;
  if (!body) return undefined;

  const bytes = await readBodyBytes(body);
  return bytes.length > 0 ? encodeBase64(bytes) : undefined;
};

export const extractBodyText = async (input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<string> => {
  if (method === 'GET' || method === 'HEAD') return '';

  if (input instanceof Request && !hasInitBody(init)) {
    const cloned = input.clone();
    return await cloned.text();
  }

  const body = init?.body;
  if (!body) return '';

  return readBodyText(body);
};

export const extractJsonBody = async (input: RequestInfo | URL, init: RequestInit | undefined, method: string): Promise<Record<string, unknown>> => {
  const bodyText = await extractBodyText(input, init, method);
  return bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
};
