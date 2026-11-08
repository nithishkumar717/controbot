const fs = require('fs');
const path = require('path');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = -1;
    this.currentAgent = null;
    this.currentProxyUrl = null;
    this.registeredClients = new Set();
    this.lastRotation = 0;
    this.isFetchingPublic = false;
    this.activeBotsRef = null;

    this.loadConfiguredProxies();
  }

  /**
   * Set reference to the activeBots array from index.js
   */
  setActiveBots(activeBots) {
    this.activeBotsRef = activeBots;
  }

  /**
   * Parse various proxy string formats into standard URL format:
   * - http://user:pass@host:port
   * - host:port:user:pass -> http://user:pass@host:port
   * - host:port -> http://host:port
   */
  normalizeProxy(proxyStr) {
    if (!proxyStr || typeof proxyStr !== 'string') return null;
    let trimmed = proxyStr.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    if (/^(http|https|socks5|socks4):\/\//i.test(trimmed)) {
      try {
        new URL(trimmed);
        return trimmed;
      } catch {
        return null;
      }
    }

    const parts = trimmed.split(':');
    if (parts.length === 2) {
      // host:port
      const [host, port] = parts;
      if (!isNaN(Number(port))) {
        return `http://${host}:${port}`;
      }
    } else if (parts.length === 4) {
      // host:port:user:pass
      const [host, port, user, pass] = parts;
      if (!isNaN(Number(port))) {
        return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
      }
    }

    return null;
  }

  /**
   * Mask proxy URL for safe logging (never expose credentials)
   */
  maskProxy(proxyUrl) {
    if (!proxyUrl) return 'none';
    try {
      const parsed = new URL(proxyUrl);
      if (parsed.username || parsed.password) {
        return `${parsed.protocol}//***:***@${parsed.hostname}:${parsed.port}`;
      }
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
    } catch {
      return 'masked-proxy';
    }
  }

  /**
   * Load proxies from environment variables, config, or proxies.txt
   */
  loadConfiguredProxies() {
    const loaded = new Set();

    // 1. Single proxy environment variables
    const singleEnv = process.env.DISCORD_PROXY || process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (singleEnv) {
      const norm = this.normalizeProxy(singleEnv);
      if (norm) loaded.add(norm);
    }

    // 2. Comma or newline separated PROXIES env var
    if (process.env.PROXIES) {
      const entries = process.env.PROXIES.split(/[\n,;]+/);
      for (const entry of entries) {
        const norm = this.normalizeProxy(entry);
        if (norm) loaded.add(norm);
      }
    }

    // 3. Check proxies.txt or proxy.txt in current directory
    const candidates = [
      path.join(__dirname, 'proxies.txt'),
      path.join(__dirname, 'proxy.txt'),
      path.join(process.cwd(), 'proxies.txt'),
      path.join(process.cwd(), 'proxy.txt')
    ];

    for (const filePath of candidates) {
      try {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const norm = this.normalizeProxy(line);
            if (norm) loaded.add(norm);
          }
        }
      } catch {}
    }

    // 4. Check config.js if present
    try {
      const config = require('./config');
      if (config.proxy) {
        const norm = this.normalizeProxy(config.proxy);
        if (norm) loaded.add(norm);
      }
      if (Array.isArray(config.proxies)) {
        for (const p of config.proxies) {
          const norm = this.normalizeProxy(p);
          if (norm) loaded.add(norm);
        }
      }
    } catch {}

    this.proxies = Array.from(loaded);
    if (this.proxies.length > 0) {
      console.log(`[ProxyManager] Loaded ${this.proxies.length} proxy/proxies into pool.`);
    }
    return this.proxies.length;
  }

  /**
   * Fallback: Fetch free public HTTP proxies dynamically if no proxies configured
   */
  async fetchPublicProxies() {
    if (this.isFetchingPublic) return;
    this.isFetchingPublic = true;
    try {
      const endpoints = [
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=4000&country=all&ssl=all&anonymity=all',
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt'
      ];

      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const text = await res.text();
            const lines = text.split(/\r?\n/).slice(0, 50); // Take first 50
            for (const line of lines) {
              const norm = this.normalizeProxy(line);
              if (norm && !this.proxies.includes(norm)) {
                this.proxies.push(norm);
              }
            }
            if (this.proxies.length > 0) {
              console.log(`[ProxyManager] Fetched ${this.proxies.length} backup public proxies.`);
              break;
            }
          }
        } catch {}
      }
    } catch (err) {
      console.warn('[ProxyManager] Public proxy fetch notice:', err.message);
    } finally {
      this.isFetchingPublic = false;
    }
  }

  /**
   * Apply a proxy URL across all Discord REST clients and undici global dispatcher
   */
  applyProxy(proxyUrl, reason = 'Rate limit triggered') {
    try {
      const agent = new ProxyAgent(proxyUrl);
      this.currentAgent = agent;
      this.currentProxyUrl = proxyUrl;

      // Update global fetch / undici dispatcher
      try {
        setGlobalDispatcher(agent);
      } catch (err) {
        console.warn('[ProxyManager] setGlobalDispatcher note:', err.message);
      }

      // Update all registered Discord.js clients REST agents
      for (const client of this.registeredClients) {
        try {
          if (client.rest && typeof client.rest.setAgent === 'function') {
            client.rest.setAgent(agent);
          }
        } catch {}
      }

      // Also update any activeBots array references
      if (this.activeBotsRef && Array.isArray(this.activeBotsRef)) {
        for (const b of this.activeBotsRef) {
          try {
            if (b.client?.rest && typeof b.client.rest.setAgent === 'function') {
              b.client.rest.setAgent(agent);
            }
          } catch {}
        }
      }

      const masked = this.maskProxy(proxyUrl);
      console.log(`[ProxyManager] Switched active proxy -> ${masked} (${reason}) [${this.currentIndex + 1}/${this.proxies.length}]`);
      return agent;
    } catch (err) {
      console.error('[ProxyManager] Error applying proxy:', err.message);
      return null;
    }
  }

  /**
   * Rotate to the next proxy when a rate limit occurs
   */
  async rotateProxy(reason = 'Rate limit encountered') {
    const now = Date.now();
    // Debounce rotations that happen within 1 second of each other
    if (now - this.lastRotation < 1000 && this.currentAgent) {
      return this.currentAgent;
    }
    this.lastRotation = now;

    // Reload proxies in case proxies.txt was updated
    this.loadConfiguredProxies();

    if (this.proxies.length === 0) {
      await this.fetchPublicProxies();
    }

    if (this.proxies.length === 0) {
      console.warn('[ProxyManager] Rate limit triggered, but no proxies available in pool or proxies.txt.');
      return null;
    }

    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
    const nextProxy = this.proxies[this.currentIndex];
    return this.applyProxy(nextProxy, reason);
  }

  /**
   * Register a Discord client to auto-listen for rate limits
   */
  registerClient(client, botIndex = 0) {
    if (!client) return;
    this.registeredClients.add(client);

    // If a proxy agent is already active, apply it immediately to this client
    if (this.currentAgent && client.rest && typeof client.rest.setAgent === 'function') {
      try {
        client.rest.setAgent(this.currentAgent);
      } catch {}
    }

    // Attach REST rateLimited event
    if (client.rest && typeof client.rest.on === 'function') {
      client.rest.on('rateLimited', async (rateLimitData) => {
        const route = rateLimitData.route || 'Discord REST';
        const timeout = rateLimitData.timeToReset || rateLimitData.retryAfter || 0;
        console.log(`[Bot ${botIndex + 1}] Rate limit hit on ${route} (reset: ${timeout}ms). Rotating proxy...`);
        await this.rotateProxy(`Discord 429 on ${route}`);
      });
    }
  }

  /**
   * Check an error and rotate proxy if it's a rate limit error
   */
  async handleRateLimit(error, reason = 'API Rate Limit') {
    if (!error) return false;
    const msg = String(error.message || error).toLowerCase();
    const isRateLimit = msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests') || msg.includes('slow down');
    if (isRateLimit) {
      await this.rotateProxy(`${reason}: ${error.message || '429 Too Many Requests'}`);
      return true;
    }
    return false;
  }
}

const proxyManager = new ProxyManager();
module.exports = proxyManager;
