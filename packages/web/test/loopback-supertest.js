import { createRequire } from 'node:module';
import { Server as TlsServer } from 'node:tls';

// supertest starts the app with `listen(0)`, which binds every interface
// (`::`), yet it sends the request to 127.0.0.1. Another process may bind
// 127.0.0.1 on that same port number, and macOS hands it the request: a
// parallel test worker's server or any app on the machine. Tests then failed
// at random with another server's 401 or 404, or with `Parse Error: Expected
// HTTP/`. Binding the loopback address supertest connects to closes the gap.
//
// `listen(0, '127.0.0.1')` binds only after an asynchronous host lookup, even
// for an IP literal, while supertest builds the request URL from the port in
// its constructor. So the request waits for the bind and takes its port then.
// Reading `address()` right after `listen` finds nothing, and supertest's own
// fallback `listen(0)` binds `::` again.
const require = createRequire(import.meta.url);
const { Test } = require('supertest');

const LOOPBACK = '127.0.0.1';
const bindings = new WeakMap();

const urlOf = (server, path) => `${server instanceof TlsServer ? 'https' : 'http'}://${LOOPBACK}:${server.address().port}${path}`;

const bindLoopback = (server) => new Promise((resolve, reject) => {
  const onError = (error) => {
    server.off('listening', onListening);
    reject(error);
  };
  const onListening = () => {
    server.off('error', onError);
    resolve();
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(0, LOOPBACK);
});

Test.prototype.serverAddress = function loopbackServerAddress(app, path) {
  if (app.address()) return urlOf(app, path);
  let binding = bindings.get(app);
  if (!binding) {
    binding = bindLoopback(app);
    bindings.set(app, binding);
    // supertest closes the server it started once the response is in.
    this._server = app;
  }
  this._loopbackBinding = binding;
  this._loopbackPath = path;
  // Replaced in `end` once the port is known; port 0 cannot reach anything.
  return `http://${LOOPBACK}:0${path}`;
};

const end = Test.prototype.end;
Test.prototype.end = function loopbackEnd(fn) {
  const binding = this._loopbackBinding;
  if (!binding) return end.call(this, fn);
  this._loopbackBinding = null;
  binding.then(() => {
    this.url = urlOf(this.app, this._loopbackPath);
    end.call(this, fn);
  }, (error) => {
    if (!fn) throw error;
    fn(error);
  });
  return this;
};

// `pipe` and `write` build the request before `end`; they would send it to
// port 0 while the server is still binding.
const buildRequest = Test.prototype.request;
Test.prototype.request = function loopbackRequest() {
  if (this._loopbackBinding) throw new Error('supertest request built before its server listens; send it with end() or await it');
  return buildRequest.call(this);
};
