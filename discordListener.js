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
    this.processedMessageIds = new Set();
    this.fullyProcessedIds = new Set();
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

    this.client.on('ready', () => this.onReady());
    this.client.on('messageCreate', (message) => this.onMessageWithDelay(message));
    this.client.on('messageUpdate', (oldMessage, newMessage) => this.onMessageUpdate(oldMessage, newMessage));
    this.client.on('error', (error) => this.onError(error));
    this.client.on('warn', (warning) => this.onWarning(warning));

    try {
      await this.client.login(config.discord.token);
    } catch (error) {
      logger.error('Failed to login to Discord', { error: error.message });
      throw error;
    }
  }

  onReady() {
    this.isReady = true;
    logger.success(`Discord bot logged in as ${this.client.user.tag}`);
    logger.info(`Monitoring ${config.discord.monitoredChannels.length} channel(s)`);
    logger.info('Bot is ready and listening for messages');
  }

  async onMessageWithDelay(message) {
    if (!config.discord.monitoredChannels.includes(message.channel.id)) return;

    if (this.processedMessageIds.has(message.id)) {
      logger.debug('Message already claimed, skipping', { messageId: message.id });
      return;
    }
    this.processedMessageIds.add(message.id);
    setTimeout(() => this.processedMessageIds.delete(message.id), 10 * 60 * 1000);

    if (message.embeds && message.embeds.length > 0) {
      logger.debug('Embed present on messageCreate, processing immediately');
      await this.onMessage(message, true);
    } else {
      logger.debug('No embed on messageCreate, waiting for messageUpdate', { messageId: message.id });
    }
  }

  async onMessageUpdate(oldMessage, newMessage) {
    if (this.fullyProcessedIds.has(newMessage.id)) return;

    const hadEmbeds = oldMessage.embeds && oldMessage.embeds.length > 0;
    const hasEmbeds = newMessage.embeds && newMessage.embeds.length > 0;

    if (!hadEmbeds && hasEmbeds) {
      if (this.processedMessageIds.has(newMessage.id)) {
        logger.debug('Embed arrived via messageUpdate, processing now', { messageId: newMessage.id });
        await this.onMessage(newMessage, true);
      }
    }
  }

  async onMessage(message, alreadyClaimed = false) {
    try {
      if (this.fullyProcessedIds.has(message.id)) {
        logger.debug('Message already fully processed, skipping', { messageId: message.id });
        return;
      }

      if (!alreadyClaimed && this.processedMessageIds.has(message.id)) {
        logger.debug('Message already claimed, skipping', { messageId: message.id });
        return;
      }

      logger.debug('Discord message event fired', {
        channelId: message.channel.id,
        channelName: message.channel.name,
        author: message.author.tag,
        authorId: message.author.id,
        isBot: message.author.bot,
        hasEmbeds: message.embeds.length > 0,
        contentLength: message.content?.length || 0,
      });

      if (message.author.bot) {
        const allowedBots = config.discord.allowedBots;
        const isAllowedBot = allowedBots.some(allowed =>
          message.author.tag.includes(allowed) ||
          message.author.username.includes(allowed)
        );

        if (!isAllowedBot) {
          logger.debug('Ignoring bot message (not in allowed list)', {
            bot: message.author.tag,
            allowedBots,
          });
          return;
        } else {
          logger.debug('Allowing message from whitelisted bot', { bot: message.author.tag });
        }
      }

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

      if (!alreadyClaimed) {
        this.processedMessageIds.add(message.id);
        setTimeout(() => this.processedMessageIds.delete(message.id), 10 * 60 * 1000);
      }

      await this.processMessage(message);

    } catch (error) {
      logger.error('Error processing message', { error: error.message });
    }
  }

  /**
   * Process and distribute message
   */
  async processMessage(message) {
    const productInfo = messageProcessor.extractProductInfo(message);
    const isQueueAlert = messageProcessor.isPokemonCenterQueueAlert(message, productInfo);

    if (isQueueAlert) {
      logger.info('Pokemon Center queue alert detected!');
      productInfo.isPokemonCenterQueue = true;
      productInfo.productName = 'Pokemon Center Queue Live';
    }

    if (!messageProcessor.isValidProductInfo(productInfo)) {
      logger.warning('Invalid product info - skipped');
      return;
    }

    // Duplicate / restock check
    // checkAndRecord now returns { action, key } so we can pass the key
    // to checkAndRecordReply for spam protection.
    let dupeAction = 'post';
    let dupeKey = null;

    if (!isQueueAlert) {
      const dupeResult = duplicateDetector.checkAndRecord(
        message.channel.id,
        productInfo.productName,
        productInfo.source || ''
      );
      dupeAction = dupeResult.action;
      dupeKey = dupeResult.key || null;

      if (dupeAction === 'suppress') {
        logger.info('Duplicate suppressed — skipping post', {
          product: productInfo.productName?.substring(0, 50) || 'N/A',
        });
        return;
      }
    }

    if (isQueueAlert) {
      logger.info('Processing Pokemon Center queue alert');
    } else {
      logger.info(`Processing restock [${dupeAction}]`, {
        product: productInfo.productName?.substring(0, 30) || 'N/A',
        price: productInfo.price,
      });
    }

    // Build distribution tasks
    const tasks = [];

    // ── Twitter ──────────────────────────────────────────────────────────────
    if (config.features.enableTwitter) {
      let tweetText;
      let imageUrls = [];
      let restockReply = null;

      if (isQueueAlert) {
        tweetText = messageProcessor.formatPokemonCenterQueueAlert();
      } else {
        // Always format the main tweet cleanly (no "still restocking" inline)
        tweetText = messageProcessor.formatForTwitter(productInfo);
        imageUrls = productInfo.images.map(img => img.url);

        // For restock repeats, prepare a reply — but only if the reply spam
        // guard approves it (once per restockWindow per product)
        if (dupeAction === 'restock') {
          const shouldReply = duplicateDetector.checkAndRecordReply(dupeKey);
          if (shouldReply) {
            restockReply =
              '⚠️ Heads up — this item keeps going in & out of stock. ' +
              'Keep refreshing and trying to check out!';
            logger.info('Reply approved for restock alert', {
              product: productInfo.productName?.substring(0, 50),
            });
          } else {
            logger.info('Reply skipped — already replied recently for this product', {
              product: productInfo.productName?.substring(0, 50),
            });
          }
        }
      }

      tasks.push(
        twitterPoster.queueTweet(tweetText, imageUrls, restockReply)
          .then(result => ({ platform: 'Twitter', ...result }))
      );
    }

    // ── Reddit ───────────────────────────────────────────────────────────────
    if (config.features.enableReddit) {
      let title, body;

      if (isQueueAlert) {
        title = '🚨 Pokemon Center Queue is LIVE!';
        body = `The Pokemon Center waiting room/security queue is now active!\n\n**Get ready to purchase!**\n\n**Link:** https://www.pokemoncenter.com\n\n---\n\n*Track more restocks at [TCGWatchtower.com](https://tcgwatchtower.com)*`;
      } else {
        const formatted = messageProcessor.formatForReddit(productInfo);
        title = formatted.title;
        body = formatted.body;
      }

      const imageUrl = !isQueueAlert && productInfo.images.length > 0 ? productInfo.images[0].url : null;

      tasks.push(
        redditPoster.queuePost(title, body, imageUrl)
          .then(result => ({ platform: 'Reddit', ...result }))
      );
    }

    // ── Website API ──────────────────────────────────────────────────────────
    if (config.features.enableWebsite && !isQueueAlert) {
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

    if (tasks.length === 0) {
      logger.warning('No platforms enabled');
      return;
    }

    const startTime = Date.now();
    const results = await Promise.allSettled(tasks);
    const elapsed = Date.now() - startTime;

    const successCount = results.filter(
      r => r.status === 'fulfilled' && r.value.success
    ).length;

    logger.success(`Distributed: ${successCount}/${results.length} platforms (${elapsed}ms)`);

    // Mark as fully processed
    this.fullyProcessedIds.add(message.id);
    setTimeout(() => this.fullyProcessedIds.delete(message.id), 10 * 60 * 1000);

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && !result.value.success) {
        logger.error(`${result.value.platform} failed`, { error: result.value.error });
      } else if (result.status === 'rejected') {
        logger.error(`Task ${index} failed`, { error: result.reason });
      }
    });
  }

  onError(error) {
    logger.error('Discord client error', { error: error.message, stack: error.stack });
  }

  onWarning(warning) {
    logger.warning('Discord client warning', { warning });
  }

  async shutdown() {
    logger.info('Shutting down Discord client...');
    if (this.client) {
      await this.client.destroy();
    }
    logger.info('Discord client shut down');
  }

  getStatus() {
    return {
      ready: this.isReady,
      username: this.client?.user?.tag,
      monitoredChannels: config.discord.monitoredChannels.length,
    };
  }
}

module.exports = new DiscordListener();
