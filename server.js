'use strict';

// Load env vars first so every module below sees them.
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { runMigrations } = require('./db/migrate');
const { requireApiKey, configuredKeys } = require('./middleware/apiKey');
const { optionalDeviceAuth } = require('./middleware/deviceAuth');
const { startReaper } = require('./services/reaper');

const serversRoutes = require('./routes/servers');
const sessionsRoutes = require('./routes/sessions');
const devicesRoutes = require('./routes/devices');
const usageRoutes = require('./routes/usage');
const configRoutes = require('./routes/config');
const internalRoutes = require('./routes/internal');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();

app.set('trust proxy', 1); // behind Render's proxy
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
app.use(express.json());

// ----- Health check (unauthenticated, for Render) ---------------------------
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'vpn-master-backend' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ----- Internal (node agents; X-Node-Secret, NOT the app key) ---------------
app.use('/internal', internalRoutes);

// ----- Public v1 API (X-API-Key on every route; device token optional) ------
const v1 = express.Router();
v1.use(requireApiKey);
v1.use(optionalDeviceAuth);
v1.use('/servers', serversRoutes);
v1.use('/sessions', sessionsRoutes);
v1.use('/devices', devicesRoutes);
v1.use('/usage', usageRoutes);
v1.use('/config', configRoutes);
app.use('/v1', v1);

// ----- 404 + error handlers -------------------------------------------------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[http] Unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
});

// ----- Boot -----------------------------------------------------------------
async function start() {
  try {
    // Fail closed in production if no app keys are configured.
    if (process.env.NODE_ENV === 'production' && configuredKeys().length === 0) {
      throw new Error('API_KEYS is required in production (X-API-Key gate). See .env.example.');
    }

    await runMigrations();
    startReaper();

    app.listen(PORT, () => {
      console.log(`[http] vpn-master-backend listening on :${PORT}`);
      if (configuredKeys().length === 0) {
        console.warn('[auth] No API_KEYS configured — X-API-Key gate is OPEN (dev only).');
      }
    });
  } catch (err) {
    console.error('[boot] Failed to start:', err);
    process.exit(1);
  }
}

start();

module.exports = app;
