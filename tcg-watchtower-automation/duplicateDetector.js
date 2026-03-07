const crypto = require('crypto');
const logger = require('./logger');
const { config } = require('./config');

class DuplicateDetector {
  constructor() {
    this.messageCache = new Map();
    this.startCleanupInterval();
  }

  /**
   * Generate a hash from message content
   */
  generateHash(content) {
    return crypto
      .createHash('sha256')
      .update(content.toLowerCase().trim())
      .digest('hex');
  }

  /**
   * Check if a message is a duplicate
   */
  isDuplicate(content) {
    const hash = this.generateHash(content);
    
    if (this.messageCache.has(hash)) {
      const timestamp = this.messageCache.get(hash);
      const age = Date.now() - timestamp;
      
      if (age < config.duplicateTimeout) {
        logger.warning('Duplicate message detected', { 
          hash: hash.substring(0, 8),
          ageMinutes: (age / 1000 / 60).toFixed(2)
        });
        return true;
      } else {
        // Old entry, remove it
        this.messageCache.delete(hash);
      }
    }
    
    // Not a duplicate, add to cache
    this.messageCache.set(hash, Date.now());
    return false;
  }

  /**
   * Cleanup old entries periodically
   */
  startCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      
      for (const [hash, timestamp] of this.messageCache.entries()) {
        if (now - timestamp > config.duplicateTimeout) {
          this.messageCache.delete(hash);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        logger.debug(`Cleaned ${cleaned} expired entries from cache`);
      }
    }, 60000); // Run every minute
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      cacheSize: this.messageCache.size,
      timeoutMinutes: config.duplicateTimeout / 1000 / 60
    };
  }
}

module.exports = new DuplicateDetector();
