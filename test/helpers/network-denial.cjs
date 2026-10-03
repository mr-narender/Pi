// Loaded before SDK imports. This is a fail-closed test guard, not a general sandbox.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');
const port = Number(process.env.PI_FIXTURE_PORT);
const log = process.env.PI_FIXTURE_NETWORK_LOG;
if (!Number.isInteger(port) || port < 1 || !log)
  throw new Error('Missing fixture guard configuration');

function deny(kind, host = '', destinationPort = 0) {
  // Never record paths, URL queries, credentials, headers or untrusted error text.
  const safeHost = /^[a-zA-Z0-9.:[\]-]+$/.test(String(host))
    ? String(host).slice(0, 253)
    : 'invalid';
  fs.appendFileSync(
    log,
    JSON.stringify({ kind, host: safeHost, port: Number(destinationPort) || 0 }) + '\n'
  );
  throw new Error('FIXTURE_NETWORK_DENIED');
}
function check(kind, host, destinationPort, secure = false, path = false) {
  const normalized = String(host || 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (secure || path || normalized !== '127.0.0.1' || Number(destinationPort) !== port) {
    deny(kind, path ? 'unix' : normalized, destinationPort);
  }
}
function socketArgs(args) {
  if (Array.isArray(args[0])) return socketArgs(args[0]);
  if (typeof args[0] === 'object') return args[0];
  if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return { path: true };
  return { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = socketArgs(args);
  check('socket', o.host, o.port, false, !!o.path);
  return connect.apply(this, args);
};
tls.connect = tls.TLSSocket.prototype.connect = function (...args) {
  const o = socketArgs(args);
  deny('tls', o.host, o.port);
};
function requestOptions(args, secure) {
  const input = args[0];
  let o;
  if (typeof input === 'string' || input instanceof URL) {
    const u = new URL(input);
    o = {
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      secure: u.protocol !== 'http:',
    };
    if (args[1] && typeof args[1] === 'object') o = { ...o, ...args[1] };
  } else o = input || {};
  check(
    secure ? 'https' : 'http',
    o.hostname || o.host,
    o.port || (secure ? 443 : 80),
    secure || o.secure,
    !!o.socketPath
  );
}
for (const [module, secure] of [
  [http, false],
  [https, true],
]) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function (...args) {
      requestOptions(args, secure);
      return original.apply(this, args);
    };
  }
}
const fetch = globalThis.fetch;
globalThis.fetch = async function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  check(
    'fetch',
    url.hostname,
    url.port || (url.protocol === 'https:' ? 443 : 80),
    url.protocol !== 'http:'
  );
  return fetch(input, options);
};
for (const name of ['connect', 'send'])
  dgram.Socket.prototype[name] = function () {
    deny('dgram', 'udp');
  };
// Resolver instances use c-ares, which does not pass through net.Socket.
for (const target of [dns, dns.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (
      name === 'lookup' ||
      name === 'lookupService' ||
      name.startsWith('resolve') ||
      name === 'reverse'
    )
      target[name] = function (host) {
        deny('dns', host, 53);
      };
  }
}
for (const target of [dns.promises, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (
      name === 'lookup' ||
      name === 'lookupService' ||
      name.startsWith('resolve') ||
      name === 'reverse'
    )
      target[name] = async function (host) {
        deny('dns', host, 53);
      };
  }
}
syncBuiltinESMExports();
