'use strict';

// ---------------------------------------------------------------------------
// share-llm — a tiny authenticating reverse proxy in front of LM Studio.
//
// LM Studio's server has NO authentication, so exposing it directly through a
// Cloudflare tunnel would let anyone with the URL use your GPU. Point the
// tunnel at THIS proxy instead: it requires a secret key and only then
// forwards to LM Studio. Streaming (SSE) responses pass through unchanged.
//
//   1. Pick a secret key:
//        node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
//   2. Run the proxy (in a terminal that stays open):
//        set ASKMYDB_SHARE_KEY=your-key   &&  node tools/share-llm.js       (Windows)
//        ASKMYDB_SHARE_KEY=your-key node tools/share-llm.js                 (macOS/Linux)
//   3. Point your Cloudflare tunnel at http://localhost:1235 (see
//      tools/cloudflared-config.example.yml).
//   4. Your friend's askmydb config uses:
//        Server URL: https://your-tunnel-hostname/v1
//        API key:    the same secret key
//
// Env vars:
//   ASKMYDB_SHARE_KEY  (required) the shared secret clients must present
//   LMSTUDIO_URL       target LM Studio server (default http://localhost:1234)
//   SHARE_PORT         port this proxy listens on (default 1235)
//   SHARE_HOST         bind address (default 127.0.0.1 — the tunnel connects locally)
// ---------------------------------------------------------------------------

const http = require('http');
const crypto = require('crypto');

const KEY = process.env.ASKMYDB_SHARE_KEY || '';
const TARGET = new URL(process.env.LMSTUDIO_URL || 'http://localhost:1234');
const PORT = Number(process.env.SHARE_PORT || 1235);
const HOST = process.env.SHARE_HOST || '127.0.0.1';

if (!KEY || KEY.length < 12) {
  console.error('\n  Refusing to start without a strong ASKMYDB_SHARE_KEY (>= 12 chars).');
  console.error('  Generate one:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n');
  process.exit(1);
}

const EXPECTED = Buffer.from(`Bearer ${KEY}`);

// Constant-time check so the key can't be guessed by timing.
function authorized(req) {
  const got = Buffer.from(req.headers['authorization'] || '');
  if (got.length !== EXPECTED.length) return false;
  try { return crypto.timingSafeEqual(got, EXPECTED); } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized — missing or wrong API key.' }));
    return;
  }
  // Do NOT forward our secret key to LM Studio (it doesn't need it and could
  // log it). Strip it before proxying.
  const fwdHeaders = { ...req.headers, host: TARGET.host };
  delete fwdHeaders.authorization;

  const opts = {
    protocol: TARGET.protocol,
    hostname: TARGET.hostname,
    port: TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: fwdHeaders
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res); // streams SSE token-by-token
  });
  // Bound the backend wait so a stuck request can't hold a socket forever.
  proxyReq.setTimeout(600000, () => proxyReq.destroy(new Error('LM Studio timed out')));
  proxyReq.on('error', (e) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Cannot reach LM Studio at ${TARGET.origin}: ${e.message}` }));
  });
  req.on('aborted', () => proxyReq.destroy());
  req.pipe(proxyReq);
});

// Slow-loris protection: drop clients that dribble headers.
server.headersTimeout = 30000;
server.requestTimeout = 0; // body/stream can be long-lived (streaming completions)

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  askmydb LLM share-proxy running');
  console.log(`  forwarding authenticated requests → ${TARGET.origin}`);
  console.log(`  listening on http://${HOST}:${PORT}  (point your Cloudflare tunnel here)`);
  console.log('  clients must send:  Authorization: Bearer <your key>');
  if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.log('');
    console.log(`  ⚠ WARNING: bound to ${HOST}, which is reachable beyond this machine.`);
    console.log('    Anyone who can reach it needs only the key. Prefer binding to 127.0.0.1');
    console.log('    and exposing it through the Cloudflare tunnel instead.');
  }
  console.log('');
});
