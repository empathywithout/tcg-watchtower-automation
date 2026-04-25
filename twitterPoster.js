const { TwitterApi } = require('twitter-api-v2');
const axios = require('axios');
const logger = require('./logger');
const { config } = require('./config');

class TwitterPoster {
  constructor() {
    this.client = null;
    this.lastPostTime = 0;
    this.queue = [];
    this.isProcessing = false;
    this.initialize();
  }

  /**
   * Initialize Twitter client
   */
  initialize() {
    if (!config.features.enableTwitter) {
      logger.info('Twitter posting is disabled');
      return;
    }

    try {
      this.client = new TwitterApi({
        appKey: config.twitter.appKey,
        appSecret: config.twitter.appSecret,
        accessToken: config.twitter.accessToken,
        accessSecret: config.twitter.accessSecret,
      });

      logger.success('Twitter client initialized');
    } catch (error) {
      logger.error('Failed to initialize Twitter client', { error: error.message });
    }
  }

  /**
   * Add tweet to queue.
   * @param {string} tweetText - Main tweet text
   * @param {string[]} imageUrls - Optional images for the main tweet
   * @param {string|null} restockReply - If set, posted as a reply to the main tweet
   *                                     (only fires when duplicateDetector approves it)
   */
  async queueTweet(tweetText, imageUrls = [], restockReply = null) {
    if (!config.features.enableTwitter || !this.client) {
      logger.warning('Twitter posting is disabled or not initialized');
      return { success: false, reason: 'disabled' };
    }

    return new Promise((resolve) => {
      this.queue.push({ tweetText, imageUrls, restockReply, resolve });
      logger.info('Tweet added to queue', { queueSize: this.queue.length });

      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process tweet queue with rate limiting
   */
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      if (this.lastPostTime > 0) {
        const timeSinceLastPost = Date.now() - this.lastPostTime;
        if (timeSinceLastPost < config.rateLimits.twitterInterval) {
          const waitTime = config.rateLimits.twitterInterval - timeSinceLastPost;
          logger.debug(`Rate limit: waiting ${waitTime}ms before next tweet`);
          await this.sleep(waitTime);
        }
      }

      const { tweetText, imageUrls, restockReply, resolve } = this.queue.shift();
      const result = await this.postTweet(tweetText, imageUrls);

      // Post reply thread if:
      //   1. A reply message was provided
      //   2. The main tweet succeeded
      //   3. We have a tweet ID to reply to
      if (restockReply && result.success && result.tweetId) {
        logger.info('Posting restock reply thread', { parentTweetId: result.tweetId });
        await this.sleep(1500); // small gap so the thread looks natural
        const replyResult = await this.postTweet(restockReply, [], result.tweetId);
        if (!replyResult.success) {
          logger.warning('Restock reply failed to post', { error: replyResult.error });
        }
      }

      resolve(result);
      this.lastPostTime = Date.now();
    }

    this.isProcessing = false;
  }

  /**
   * Post a tweet with optional images and optional reply-to parent.
   * @param {string} tweetText
   * @param {string[]} imageUrls
   * @param {string|null} replyToTweetId - If set, posts as a reply to this tweet ID
   */
  async postTweet(tweetText, imageUrls = [], replyToTweetId = null) {
    try {
      logger.debug('Posting to Twitter...', {
        textLength: tweetText.length,
        images: imageUrls.length,
        isReply: !!replyToTweetId,
      });

      let mediaIds = [];

      if (imageUrls.length > 0) {
        mediaIds = await this.uploadImages(imageUrls);
      }

      const tweetPayload = {
        text: tweetText,
      };

      if (mediaIds.length > 0) {
        tweetPayload.media = { media_ids: mediaIds };
      }

      // Attach to parent tweet if this is a reply
      if (replyToTweetId) {
        tweetPayload.reply = { in_reply_to_tweet_id: replyToTweetId };
      }

      const tweet = await this.client.v2.tweet(tweetPayload);

      logger.success('Tweet posted', {
        tweetId: tweet.data.id,
        isReply: !!replyToTweetId,
      });

      return {
        success: true,
        tweetId: tweet.data.id,
        url: `https://twitter.com/i/web/status/${tweet.data.id}`,
      };

    } catch (error) {
      logger.error('Failed to post tweet', {
        error: error.message,
        code: error.code,
        data: error.data,
        errors: error.errors,
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Upload images to Twitter
   */
  async uploadImages(imageUrls) {
    const mediaIds = [];
    const maxImages = Math.min(imageUrls.length, 4);

    const uploadPromises = imageUrls.slice(0, maxImages).map(async (imageUrl) => {
      try {
        logger.debug('Downloading image for Twitter', { url: imageUrl });

        const response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
        });

        const imageBuffer = Buffer.from(response.data);

        const mediaId = await this.client.v1.uploadMedia(imageBuffer, {
          mimeType: response.headers['content-type'],
        });

        logger.debug('Image uploaded to Twitter', { mediaId });
        return mediaId;

      } catch (error) {
        logger.warning('Failed to upload image to Twitter', {
          url: imageUrl,
          error: error.message,
        });
        return null;
      }
    });

    const results = await Promise.all(uploadPromises);
    return results.filter(id => id !== null);
  }

  /**
   * Verify Twitter credentials
   */
  async verifyCredentials() {
    if (!this.client) {
      return { valid: false, error: 'Client not initialized' };
    }

    try {
      const user = await this.client.v2.me();
      logger.success('Twitter credentials verified', { username: user.data.username });
      return { valid: true, user: user.data };
    } catch (error) {
      logger.error('Twitter credentials invalid', { error: error.message });
      return { valid: false, error: error.message };
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      enabled: config.features.enableTwitter,
      initialized: !!this.client,
      queueSize: this.queue.length,
      isProcessing: this.isProcessing,
      lastPostTime: this.lastPostTime,
    };
  }
}

module.exports = new TwitterPoster();
