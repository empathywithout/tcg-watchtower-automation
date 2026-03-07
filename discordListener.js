const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./logger');
const { config } = require('./config');
const messageProcessor = require('./messageProcessor');
const duplicateDetector = require('./duplicateDetector');
const twitterPoster = require('./twitterPoster');
const redditPoster = require('./redditPoster');
const websitePoster = require('./websitePoster');

class DiscordListener {
  constructor() {
    this.client = null;
    this.isReady = false;
  }

  /**
   * Initialize Discord client
   */
  async initialize() {
    logger.info('Initializing Discord client...');

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Event handlers
    this.client.on('ready', () => this.onReady());
    this.client.on('messageCreate', (message) => this.onMessage(message));
    this.client.on('error', (error) => this.onError(error));
    this.client.on('warn', (warning) => this.onWarning(warning));

    // Login
    try {
      await this.client.login(config.discord.token);
    } catch (error) {
      logger.error('Failed to login to Discord', { error: error.message });
      throw error;
    }
  }

  /**
   * Handle ready event
   */
  onReady() {
    this.isReady = true;
    logger.success(`Discord bot logged in as ${this.client.user.tag}`);
    logger.info(`Monitoring ${config.discord.monitoredChannels.length} channel(s)`);
    logger.info('Bot is ready and listening for messages');
  }

  /**
   * Handle new messages
   */
  async onMessage(message) {
    try {
      // DEBUG: Log every message received
      logger.debug('Discord message event fired', {
        channelId: message.channel.id,
        channelName: message.channel.name,
        author: message.author.tag,
        authorId: message.author.id,
        isBot: message.author.bot,
        hasEmbeds: message.embeds.length > 0,
        contentLength: message.content?.length || 0,
      });

      // Allow messages from specific bots (like TCG Watchtower Monitors), ignore all others
      if (message.author.bot) {
        const allowedBots = config.discord.allowedBots;
        
        const isAllowedBot = allowedBots.some(allowed => 
          message.author.tag.includes(allowed) || 
          message.author.username.includes(allowed)
        );
        
        if (!isAllowedBot) {
          logger.debug('Ignoring bot message (not in allowed list)', {
            bot: message.author.tag,
            allowedBots: allowedBots
          });
          return;
        } else {
          logger.debug('Allowing message from whitelisted bot', {
            bot: message.author.tag
          });
        }
      }

      // Check if message is from a monitored channel
      if (!config.discord.monitoredChannels.includes(message.channel.id)) {
        logger.debug('Channel not monitored', {
          channelId: message.channel.id,
          monitoredChannels: config.discord.monitoredChannels,
        });
        return;
      }

      logger.info('Message received', {
        channel: message.channel.name,
        author: message.author.tag,
      });

      // Check for duplicates
      if (duplicateDetector.isDuplicate(message.content)) {
        logger.warning('Duplicate ignored');
        return;
      }

      // Process the message
      await this.processMessage(message);

    } catch (error) {
      logger.error('Error processing message', { error: error.message });
    }
  }

  /**
   * Process and distribute message
   */
  async processMessage(message) {
    // Extract product information
    const productInfo = messageProcessor.extractProductInfo(message);

    // Validate product info
    if (!messageProcessor.isValidProductInfo(productInfo)) {
      logger.warning('Invalid product info - skipped');
      return;
    }

    logger.info('Processing restock', {
      product: productInfo.productName?.substring(0, 30) || 'N/A',
      price: productInfo.price,
    });

    // Prepare distribution tasks - all execute in parallel
    const tasks = [];

    // Twitter
    if (config.features.enableTwitter) {
      const tweetText = messageProcessor.formatForTwitter(productInfo);
      const imageUrls = productInfo.images.map(img => img.url);
      tasks.push(
        twitterPoster.queueTweet(tweetText, imageUrls)
          .then(result => ({ platform: 'Twitter', ...result }))
      );
    }

    // Reddit
    if (config.features.enableReddit) {
      const { title, body } = messageProcessor.formatForReddit(productInfo);
      const imageUrl = productInfo.images.length > 0 ? productInfo.images[0].url : null;
      tasks.push(
        redditPoster.queuePost(title, body, imageUrl)
          .then(result => ({ platform: 'Reddit', ...result }))
      );
    }

    // Website API
    if (config.features.enableWebsite) {
      const websiteData = messageProcessor.formatForWebsite(
        productInfo,
        message.id,
        message.channel.id
      );
      tasks.push(
        websitePoster.postRestock(websiteData)
          .then(result => ({ platform: 'Website', ...result }))
      );
    }

    // Execute all distribution tasks in parallel
    if (tasks.length === 0) {
      logger.warning('No platforms enabled');
      return;
    }

    const startTime = Date.now();
    const results = await Promise.allSettled(tasks);
    const elapsed = Date.now() - startTime;

    // Count successes
    const successCount = results.filter(
      r => r.status === 'fulfilled' && r.value.success
    ).length;

    logger.success(`Distributed: ${successCount}/${results.length} platforms (${elapsed}ms)`);
    
    // Log failures only
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && !result.value.success) {
        logger.error(`${result.value.platform} failed`, { error: result.value.error });
      } else if (result.status === 'rejected') {
        logger.error(`Task ${index} failed`, { error: result.reason });
      }
    });
  }

  /**
   * Handle Discord errors
   */
  onError(error) {
    logger.error('Discord client error', { error: error.message, stack: error.stack });
  }

  /**
   * Handle Discord warnings
   */
  onWarning(warning) {
    logger.warning('Discord client warning', { warning });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down Discord client...');
    if (this.client) {
      await this.client.destroy();
    }
    logger.info('Discord client shut down');
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      ready: this.isReady,
      username: this.client?.user?.tag,
      monitoredChannels: config.discord.monitoredChannels.length,
    };
  }
}

module.exports = new DiscordListener();
