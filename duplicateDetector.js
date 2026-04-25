const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { config } = require('./config');

/**
 * Result shapes returned by checkAndRecord():
 *
 *   { action: 'post'    }  — Never seen before. Post normally.
 *   { action: 'suppress'}  — Same product+retailer+channel within suppressWindow. Drop silently.
 *   { action: 'restock' }  — Past suppressWindow but within restockWindow. Post with reply note.
 *
 * checkAndRecordReply():
 *   Returns true if a reply should be posted (i.e. we haven't replied for this
 *   product yet within the restockWindow). Prevents reply spam when many restock
 *   alerts fire in quick succession for the same product.
 */

const CACHE_FILE = path.join(__dirname, '.duplicate-cache.json');
const REPLY_CACHE_FILE = path.join(__dirname, '.reply-cache.json');

class DuplicateDetector {
  constructor() {
    this.cache = new Map();
    this.replyCache = new Map(); // tracks last reply time per product key
    this.loadFromDisk();
    this.startCleanupInterval();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  loadFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        const entries = JSON.parse(raw);
        for (const [key, entry] of entries) {
          this.cache.set(key, entry);
        }
        logger.info(`Duplicate cache loaded from disk (${this.cache.size} entries)`);
        this._purgeExpired();
      } else {
        logger.debug('No duplicate cache file found — starting fresh');
      }
    } catch (err) {
      logger.warning('Could not load duplicate cache from disk — starting fresh', {
        error: err.message,
      });
      this.cache = new Map();
    }

    try {
      if (fs.existsSync(REPLY_CACHE_FILE)) {
        const raw = fs.readFileSync(REPLY_CACHE_FILE, 'utf8');
        const entries = JSON.parse(raw);
        for (const [key, entry] of entries) {
          this.replyCache.set(key, entry);
        }
        logger.info(`Reply cache loaded from disk (${this.replyCache.size} entries)`);
      }
    } catch (err) {
      logger.warning('Could not load reply cache from disk — starting fresh', {
        error: err.message,
      });
      this.replyCache = new Map();
    }
  }

  saveToDisk() {
    try {
      const entries = Array.from(this.cache.entries());
      const tmp = CACHE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
    } catch (err) {
      logger.warning('Could not save duplicate cache to disk', { error: err.message });
    }
  }

  saveReplyToDisk() {
    try {
      const entries = Array.from(this.replyCache.entries());
      const tmp = REPLY_CACHE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries), 'utf8');
      fs.renameSync(tmp, REPLY_CACHE_FILE);
    } catch (err) {
      logger.warning('Could not save reply cache to disk', { error: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Key building
  // ---------------------------------------------------------------------------

  buildKey(channelId, productName, source) {
    const normName = (productName || '')
      .toLowerCase()
      .replace(/\[<@&\d+>\]/g, '')
      .replace(/\(ping id: \d+\)/gi, '')
      .replace(/@?\s*\$[\d.,]+/g, '')
      .replace(/item restocked|restock alert/gi, '')
      .replace(/\[(high|low|limited|in)\s*stock\]/gi, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const normSource = (source || '').toLowerCase().trim();
    const raw = `${channelId}|${normName}|${normSource}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Core check
  // ---------------------------------------------------------------------------

  checkAndRecord(channelId, productName, source) {
    const key = this.buildKey(channelId, productName, source);
    const now = Date.now();

    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      const ageSinceLast  = now - entry.lastSeen;
      const ageSinceFirst = now - entry.firstSeen;

      if (ageSinceLast < config.suppressWindow) {
        logger.warning('Duplicate suppressed', {
          product: (productName || '').substring(0, 50),
          channel: channelId,
          ageSinceLastMinutes: (ageSinceLast / 60000).toFixed(1),
        });
        return { action: 'suppress' };
      }

      if (config.restockWindow > 0 && ageSinceFirst < config.restockWindow) {
        entry.lastSeen = now;
        entry.postCount += 1;
        this.saveToDisk();
        logger.info('Restock repeat — posting with still-restocking reply', {
          product: (productName || '').substring(0, 50),
          postCount: entry.postCount,
        });
        return { action: 'restock', key };
      }

      this.cache.delete(key);
    }

    this.cache.set(key, { firstSeen: now, lastSeen: now, postCount: 1 });
    this.saveToDisk();
    logger.debug('New product recorded', {
      product: (productName || '').substring(0, 50),
      channel: channelId,
      key: key.substring(0, 8),
    });
    return { action: 'post', key };
  }

  /**
   * Check whether we should post a reply for this product.
   * Returns true only if no reply has been posted within restockWindow.
   * This prevents reply spam when many alerts fire for the same product.
   */
  checkAndRecordReply(key) {
    if (!key) return false;

    const now = Date.now();

    if (this.replyCache.has(key)) {
      const lastReply = this.replyCache.get(key).lastReply;
      const age = now - lastReply;

      if (age < config.restockWindow) {
        logger.info('Reply suppressed — already replied within restockWindow', {
          key: key.substring(0, 8),
          ageMinutes: (age / 60000).toFixed(1),
          restockWindowMinutes: (config.restockWindow / 60000).toFixed(0),
        });
        return false;
      }
    }

    // Record this reply
    this.replyCache.set(key, { lastReply: now });
    this.saveReplyToDisk();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  _purgeExpired() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.firstSeen > config.restockWindow) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    // Also purge reply cache
    for (const [key, entry] of this.replyCache.entries()) {
      if (now - entry.lastReply > config.restockWindow) {
        this.replyCache.delete(key);
      }
    }
    return cleaned;
  }

  startCleanupInterval() {
    setInterval(() => {
      const cleaned = this._purgeExpired();
      if (cleaned > 0) {
        logger.debug(`Cleaned ${cleaned} expired entries from duplicate cache`);
        this.saveToDisk();
        this.saveReplyToDisk();
      }
    }, 60_000);
  }

  getStats() {
    return {
      cacheSize: this.cache.size,
      replyCacheSize: this.replyCache.size,
      suppressWindowMinutes: config.suppressWindow / 60000,
      restockWindowMinutes: config.restockWindow / 60000,
      cacheFile: CACHE_FILE,
    };
  }
}

module.exports = new DuplicateDetector();
