const PREFLIGHT_CACHE_SECONDS = '600';

export const applyRuntimeCorsHeaders = ({ origin, setHeader }) => {
  setHeader('Access-Control-Allow-Origin', origin);
  setHeader('Access-Control-Allow-Credentials', 'true');
  setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding');
  setHeader('Access-Control-Expose-Headers', 'x-next-cursor');
  setHeader('Access-Control-Max-Age', PREFLIGHT_CACHE_SECONDS);
  setHeader('Vary', 'Origin');
};
