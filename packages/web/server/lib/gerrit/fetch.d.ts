export {};

declare global {
  function fetch(input: string | URL | Request, init?: Omit<RequestInit, 'body'> & {
    body?: BodyInit | null | undefined;
  }): Promise<Response>;
}
