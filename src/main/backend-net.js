// ─── BACKEND AĞ KATMANI ──────────────────────────────────────────────────────
// Flask backend'e giden HTTPS istekleri: boş port bulma, hazır olma probu ve
// JSON istek yardımcıları. Ana süreç sabitlerine (HOST/APP_TOKEN/PORT) doğrudan
// bağlı olmamak için fabrika ile yapılandırılır; böylece test edilebilir kalır.

const https = require('https');
const net = require('net');

const {
  getPinnedHttpsOptions,
  getBackendKeepAliveAgent,
} = require('./certificates');

function createBackendNet({ host, getToken, getPort, timeoutMs, retryIntervalMs, probeTimeoutMs }) {
  // Backend'e giden genel amaçlı JSON isteği (keep-alive havuzu üzerinden).
  function requestBackendJson(pathname, { method = 'GET', body = null, timeout = 1200 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = https.request(
        {
          hostname: host,
          port: getPort(),
          path: pathname,
          method,
          timeout,
          agent: getBackendKeepAliveAgent(),
          ...getPinnedHttpsOptions(),
          headers: {
            'X-App-Token': getToken(),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Backend ${pathname} HTTP ${res.statusCode}`));
              return;
            }
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (err) { reject(err); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Backend ${pathname} zaman asimi`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // /heartbeat POST'larıyla backend hazır olana kadar yeniden dener.
  function waitForBackendReady(resolve, reject, waitTimeoutMs) {
    const effectiveTimeout = waitTimeoutMs || timeoutMs;
    const deadline = Date.now() + effectiveTimeout;
    let lastError = 'HTTPS bağlantısı kurulamadı.';

    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(
          `Flask ${effectiveTimeout / 1000}s içinde HTTPS üzerinden hazır olmadı: ${lastError}`
        ));
        return;
      }
      setTimeout(probe, retryIntervalMs);
    };

    const probe = () => {
      let probeHandled = false;
      const retryProbe = (error) => {
        if (probeHandled) return;
        probeHandled = true;
        lastError = error instanceof Error ? error.message : String(error || lastError);
        retry();
      };

      const request = https.request({
        hostname: host,
        port: getPort(),
        path: '/heartbeat',
        method: 'POST',
        timeout: probeTimeoutMs,
        ...getPinnedHttpsOptions(),
        headers: { 'X-App-Token': getToken() },
      }, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (!probeHandled) {
            probeHandled = true;
            resolve();
          }
          return;
        }
        retryProbe(new Error(`Backend HTTP ${response.statusCode}`));
      });

      request.once('error', retryProbe);
      request.once('timeout', () => {
        request.destroy(new Error('Backend HTTPS kontrolü zaman aşımına uğradı.'));
      });
      request.end();
    };

    probe();
  }

  // Yerel sunucu için müsait bir TCP portu seçer.
  function findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() =>
          port ? resolve(port) : reject(new Error('Bos port bulunamadi.'))
        );
      });
    });
  }

  return { requestBackendJson, waitForBackendReady, findFreePort };
}

module.exports = { createBackendNet };
