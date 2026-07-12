'use strict';

const path = require('path');
const express = require('express');
const { loadConfig } = require('./src/config');
const { createRoutes } = require('./src/routes');

const config = loadConfig();
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', createRoutes(config));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: err.message || 'Internal error' });
});

const port = Number(process.env.PORT || config.port || 3600);
// Bound to localhost by default on purpose: the app has no login of its own.
// Set HOST=0.0.0.0 only if you understand that anyone on your network could query your DB.
const host = process.env.HOST || '127.0.0.1';

app.listen(port, host, () => {
  console.log('');
  console.log('  askmydb is running');
  console.log(`  Open http://${host === '0.0.0.0' ? 'localhost' : host}:${port} in your browser`);
  console.log('');
});
