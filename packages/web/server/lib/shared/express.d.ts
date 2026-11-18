declare module 'express' {
  const express: import('./http-contracts.js').ExpressFactory;
  export default express;
}
