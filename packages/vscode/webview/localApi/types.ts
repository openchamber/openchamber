export type LocalApiHandlerContext = {
  input: RequestInfo | URL;
  url: URL;
  init: RequestInit | undefined;
  method: string;
  pathname: string;
  normalizedPathname: string;
};

export type LocalApiRouteHandler = (ctx: LocalApiHandlerContext) => Promise<Response | null>;
