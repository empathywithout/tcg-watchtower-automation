const crypto = require('crypto');
const logger = require('./logger');
const { config } = require('./config');

/**
 * Result shapes returned by checkAndRecord():
 *
 *   { action: 'post'    }  — Never seen before. Post normally.
 *                            This is ALWAYS the result for a brand-new product, no matter
 *                            what else is in the cache. New items are never blocked.
 *
 *   { action: 'suppress'}  — Same product+retailer+channel was already posted within
 *                            suppressWindow (default 15 min). Drop silently.
 *
 *   { action: 'restock' }  — suppressWindow has expired (item was posted >15 min ago)
 *                            but the item is still bouncing in/out of stock within the
 *                            restockWindow (default 120 min). Post again with a note.
 *                            After this post, a fresh suppressWindow starts again so
 *                            rapid follow-up alerts are still blocked.
 *
 * The key is: channelId + normalised product name + retailer (from embed footer).
 * Target vs Walmart = different keys = both always post independently.
 */

class DuplicateDetector {
  constructor() {
    // key -> { firstSeen: ms, lastSeen: ms, postCount: number }
    this.cache = new Map();
    this.startCleanupInterval();
  }

  /**
   * Build a stable cache key from channel + product name + retailer.
   * Retailer is kept in the key so the same product at different stores never conflicts.
   */
  buildKey(channelId, productName, source) {
    const normName = (productName || '')
      .toLowerCase()
      .replace(/\[<@&\d+>\]/g, '')           // Discord role mentions
      .replace(/\(ping id: \d+\)/gi, '')      // ping IDs
      .replace(/@?\s*\$[\d.,]+/g, '')         // prices
      .replace(/item restocked|restock alert/gi, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Source footer looks like "TCG Watchtower Monitors • Target • 11:27:00 AM EST"
    // Keeping it in the key means Target and Walmart are treated as separate products.
    const normSource = (source || '').toLowerCase().trim();

    const raw = `${channelId}|${normName}|${normSource}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Check a product against the cache and record it.
   *
   * @param {string} channelId   - Discord channel ID the message came from
   * @param {string} productName - Extracted product name
   * @param {string} source      - embed.footer.text (contains retailer name)
   * @returns {{ action: 'post'|'suppress'|'restock' }}
   */
  checkAndRecord(channelId, productName, source) {
    const key = this.buildKey(channelId, productName, source);
    const now = Date.now();

    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      const ageSinceLast  = now - entry.lastSeen;
      const ageSinceFirst = now - entry.firstSeen;

      if (ageSinceLast < config.suppressWindow) {
        // Posted too recently — drop silently
        logger.warning('Duplicate suppressed', {
          product: (productName || '').substring(0, 50),
          channel: channelId,
          ageSinceLastMinutes: (ageSinceLast / 60000).toFixed(1),
        });
        return { action: 'suppress' };
      }

      if (config.restockWindow > 0 && ageSinceFirst < config.restockWindow) {
        // Past the suppress window but still in the restock observation window —
        // post with a "still restocking" note and reset lastSeen so the next
        // suppress window starts fresh from this post.
        entry.lastSeen = now;
        entry.postCount += 1;
        logger.info('Restock repeat — posting with still-restocking note', {
          product: (productName || '').substring(0, 50),
          postCount: entry.postCount,
        });
        return { action: 'restock' };
      }

      // Both windows fully expired — treat as a fresh new post and reset the entry
      this.cache.delete(key);
    }

    // Brand-new product (no cache entry), or fully expired entry that was just cleared.
    // Always posts normally — a new item can NEVER be blocked by this check.
    this.cache.set(key, { firstSeen: now, lastSeen: now, postCount: 1 });
    logger.debug('New product recorded', {
      product: (productName || '').substring(0, 50),
      channel: channelId,
      key: key.substring(0, 8),
    });
    return { action: 'post' };
  }

  /**
   * Periodically purge entries where the full restock window has expired.
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, entry] of this.cache.entries()) {
        if (now - entry.firstSeen > config.restockWindow) {
          this.cache.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug(`Cleaned ${cleaned} expired entries from duplicate cache`);
      }
    }, 60_000);
  }

  getStats() {
    return {
      cacheSize: this.cache.size,
      suppressWindowMinutes: config.suppressWindow / 60000,
      restockWindowMinutes: config.restockWindow / 60000,
    };
  }
}

module.exports = new DuplicateDetector();
