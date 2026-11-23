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

// Monitoring must never break the app. SDK 0.2.0 leaves `security` undefined when the key or
// endpoint is missing, which crashed login; fill in harmless no-ops so every call is always safe.
const noop = () => {};
const SECURITY_EVENTS = ['loginSucceeded', 'loginFailed', 'logout', 'mfaFailed', 'passwordReset', 'accessDenied', 'rateLimited', 'adminAction', 'permissionChanged', 'inputRejected'];
shieldops.security = shieldops.security || {};
for (const name of SECURITY_EVENTS) if (typeof shieldops.security[name] !== 'function') shieldops.security[name] = noop;
if (typeof shieldops.requestHandler !== 'function') shieldops.requestHandler = () => (req, res, next) => next();
if (typeof shieldops.errorHandler !== 'function') shieldops.errorHandler = () => (err, req, res, next) => next(err);
if (!enabled) console.warn('[shieldops] Monitoring is off: set SHIELDOPS_KEY and SHIELDOPS_ENDPOINT to turn it on.');

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