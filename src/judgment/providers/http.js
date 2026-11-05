// Minimal JSON-over-HTTPS POST using Node's built-in modules. The extension targets VS Code
// >= 1.74, whose extension host (Node 16) has no global fetch, so this avoids depending on it
// and adds no dependency. Providers take this as an injectable `postJson`, which is how the
// tests replace the network.
//
// postJson(url, headers, body, { timeoutMs, maxBytes }) -> Promise<{ status, json, text }>
// Rejects with AiError('NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE'). Error messages carry only the
// error code (e.g. ECONNREFUSED): never the URL, headers or body.
//
// Every exit path goes through settle(), so the promise settles exactly once and late events
// from a request that was torn down (timeout, oversized body) are ignored, never thrown.

const https = require('https');
const http = require('http');
const { AiError } = require('./errors');

function postJson(url, headers, body, options) {
  const timeoutMs = (options && options.timeoutMs) || 30000;
  const maxBytes = (options && options.maxBytes) || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let u;
    try { u = new URL(url); } catch (e) { settle(reject, new AiError('NETWORK', 'Invalid AI provider URL.')); return; }
    const lib = u.protocol === 'http:' ? http : https; // http only ever used by tests against localhost
    const payload = JSON.stringify(body);

    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          settle(reject, new AiError('BAD_RESPONSE', 'The AI provider response was too large.'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        settle(resolve, { status: res.statusCode, json, text });
      });
      res.on('error', () => settle(reject, new AiError('NETWORK', 'Network error while reading the AI response.')));
      res.on('aborted', () => settle(reject, new AiError('NETWORK', 'The connection to the AI provider was interrupted.')));
    });

    req.setTimeout(timeoutMs, () => {
      settle(reject, new AiError('TIMEOUT', 'The AI provider did not respond in time.'));
      req.destroy();
    });
    req.on('error', (err) => {
      settle(reject, new AiError('NETWORK', `Network error contacting the AI provider (${(err && err.code) || 'request failed'}).`));
    });
    req.end(payload);
  });
}

module.exports = { postJson };
