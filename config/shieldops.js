// ShieldOps monitoring: API performance, errors, security events and logs.
// Sends nothing unless SHIELDOPS_KEY and SHIELDOPS_ENDPOINT are set, so local development is unaffected.
const { ShieldOps } = require('@shieldops/node');

const enabled = Boolean(process.env.SHIELDOPS_KEY && process.env.SHIELDOPS_ENDPOINT);

const shieldops = ShieldOps.init({
  key: process.env.SHIELDOPS_KEY,
  endpoint: process.env.SHIELDOPS_ENDPOINT,
  environment: process.env.NODE_ENV || 'production',
  // Render sets RENDER_GIT_COMMIT on every deploy; elsewhere set APP_VERSION.
  release: process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION,
  enabled,
});

/**
 * Forwards console output to ShieldOps:
 *  - every console line becomes a searchable log line (Logs page);
 *  - every Error passed to console.error becomes an error report (Errors page).
 * Most controllers catch their own errors and call console.error(error) before answering 500,
 * so without this those errors would never reach ShieldOps.
 */
if (enabled) {
  let forwarding = false;
  const text = (args) => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a))).join(' ').slice(0, 2000);
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      if (forwarding || (typeof args[0] === 'string' && args[0].startsWith('[shieldops]'))) return;
      forwarding = true;
      try {
        ShieldOps.logger[level](text(args));
        if (method === 'error') {
          const err = args.find((a) => a instanceof Error);
          if (err) ShieldOps.captureException(err);
        }
      } catch {
        /* monitoring must never break the app */
      } finally {
        forwarding = false;
      }
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = shieldops;