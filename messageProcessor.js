const logger = require('./logger');
const { config } = require('./config');

class MessageProcessor {
  /**
   * Extract product information from Discord message
   */
  extractProductInfo(message) {
    const content = message.content || '';
    const lines = content.split('\n').filter(line => line.trim());

    const productInfo = {
      rawContent: content,
      productName: null,
      price: null,
      link: null,
      sku: null,
      images: [],
      emojis: this.extractEmojis(content),
      hashtags: this.extractHashtags(content),
    };

    // PRIORITY 1: Extract from Discord embeds (structured data)
    if (message.embeds && message.embeds.length > 0) {
      const embed = message.embeds[0];

      if (embed.title) {
        productInfo.productName = embed.title;
        productInfo.rawContent = embed.title;
      }

      if (embed.url) {
        productInfo.affiliateLink = embed.url;
      }

      if (embed.description) {
        productInfo.rawContent = embed.description;
      }

      if (embed.fields && embed.fields.length > 0) {
        embed.fields.forEach(field => {
          const fieldName = field.name.toLowerCase();
          const fieldValue = field.value;

          if (fieldName.includes('sku')) {
            productInfo.sku = fieldValue.trim();
          }

          if (fieldName.includes('price')) {
            const priceMatch = fieldValue.match(/\$\s*(\d+\.?\d*)/);
            if (priceMatch) {
              productInfo.price = `$${priceMatch[1]}`;
            }
          }

          if (fieldName.includes('link')) {
            const linkMatches = fieldValue.match(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g);
            if (linkMatches) {
              const firstLink = linkMatches[0];
              const urlMatch = firstLink.match(/\((https?:\/\/[^\)]+)\)/);
              if (urlMatch) {
                productInfo.link = urlMatch[1];
              }

              productInfo.allLinks = linkMatches.map(link => {
                const match = link.match(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/);
                if (match) {
                  return { name: match[1], url: match[2] };
                }
                return null;
              }).filter(Boolean);
            } else {
              const urlMatch = fieldValue.match(/https?:\/\/[^\s\)]+/);
              if (urlMatch) {
                productInfo.link = urlMatch[0];
              }
            }
          }
        });
      }

      if (embed.thumbnail && embed.thumbnail.url) {
        productInfo.images.push({ url: embed.thumbnail.url, name: 'thumbnail' });
      }

      if (embed.image && embed.image.url) {
        productInfo.images.push({ url: embed.image.url, name: 'embedded_image' });
      }

      // Strip timestamp from footer so the cache key is stable across repeated alerts
      if (embed.footer && embed.footer.text) {
        const footerText = embed.footer.text;
        productInfo.source = footerText
          .replace(/•\s*\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s*(AM|PM))?(\s*\w+)?\s*$/i, '')
          .trim();
      }

      if (productInfo.productName || productInfo.price || productInfo.link) {
        logger.debug('Extracted product info from embed', productInfo);
        return productInfo;
      }
    }

    // PRIORITY 2: Extract from plain text (fallback)
    if (!productInfo.productName) {
      for (const line of lines) {
        const cleanLine = line.replace(/[🚨⚡️✨💎]/g, '').trim();
        if (
          cleanLine &&
          !cleanLine.startsWith('http') &&
          !cleanLine.startsWith('$') &&
          !cleanLine.toLowerCase().includes('retail') &&
          !cleanLine.toLowerCase().includes('grab it') &&
          !cleanLine.toLowerCase().includes('track more')
        ) {
          if (!productInfo.productName && cleanLine.length > 5) {
            productInfo.productName = cleanLine;
          }
        }
      }
    }

    if (!productInfo.price) {
      const priceMatch = content.match(/\$\s*(\d+\.?\d*)/);
      if (priceMatch) {
        productInfo.price = `$${priceMatch[1]}`;
      }
    }

    if (!productInfo.link) {
      const linkMatches = content.match(/https?:\/\/[^\s]+/g);
      if (linkMatches && linkMatches.length > 0) {
        productInfo.link = linkMatches[0];
      }
    }

    if (message.attachments && message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          productInfo.images.push({ url: attachment.url, name: attachment.name });
        }
      });
    }

    logger.debug('Extracted product info', productInfo);
    return productInfo;
  }

  extractEmojis(text) {
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
    return text.match(emojiRegex) || [];
  }

  extractHashtags(text) {
    const hashtagRegex = /#[\w]+/g;
    return text.match(hashtagRegex) || [];
  }

  /**
   * Format message for Twitter (280 char limit).
   * Always produces a clean tweet — no inline "still restocking" note.
   * The restock note is posted as a reply thread by twitterPoster.
   */
  formatForTwitter(productInfo) {
    let tweet = '';

    if (productInfo.productName) {
      let productName = productInfo.productName
        .replace(/Item Restocked/i, '')
        .replace(/Restock Alert/i, '')
        .replace(/\[<@&\d+>\]/g, '')
        .replace(/\(Ping ID: \d+\)/g, '')
        .replace(/@\s*\$[\d.]+/g, '')
        .trim();

      tweet += productName;
    } else {
      tweet += 'New Product Available';
    }

    tweet += '\n\n';

    // Pick the best link
    let linkToUse = null;
    let linkName = null;

    if (productInfo.affiliateLink) {
      linkToUse = productInfo.affiliateLink;
    } else if (productInfo.allLinks && productInfo.allLinks.length > 0) {
      const utilityPlatforms = ['keepa', 'selleramp', 'google'];
      const preferredOrder = ['amazon', 'target', 'walmart', 'ebay'];

      for (const preferred of preferredOrder) {
        const found = productInfo.allLinks.find(l =>
          l.name.toLowerCase().includes(preferred)
        );
        if (found) {
          linkToUse = found.url;
          linkName = found.name;
          break;
        }
      }

      if (!linkToUse) {
        const buyLink = productInfo.allLinks.find(l =>
          !utilityPlatforms.some(u => l.name.toLowerCase().includes(u))
        );
        linkToUse = buyLink ? buyLink.url : productInfo.allLinks[0].url;
        linkName = buyLink ? buyLink.name : productInfo.allLinks[0].name;
      }
    } else if (productInfo.link) {
      linkToUse = productInfo.link;
    }

    if (linkToUse) {
      tweet += linkName ? `🔗 ${linkName}: ${linkToUse}\n\n` : `🔗 ${linkToUse}\n\n`;
    }

    // Hashtags
    let hashtags = productInfo.hashtags.length > 0
      ? productInfo.hashtags
      : config.defaultHashtags;

    let hashtagString = hashtags.join(' ');

    while ((tweet + hashtagString).length > 280 && hashtags.length > 0) {
      hashtags.pop();
      hashtagString = hashtags.join(' ');
    }

    tweet += hashtagString;

    // Final length safety
    if (tweet.length > 280) {
      const maxProductNameLength = 80;
      let shortProductName = (productInfo.productName || 'Product')
        .replace(/\[<@&\d+>\]/g, '')
        .replace(/\(Ping ID: \d+\)/g, '')
        .replace(/@\s*\$[\d.]+/g, '')
        .trim();

      if (shortProductName.length > maxProductNameLength) {
        shortProductName = shortProductName.substring(0, maxProductNameLength) + '...';
      }

      tweet = shortProductName + '\n\n';

      if (linkToUse) {
        tweet += linkName ? `🔗 ${linkName}: ${linkToUse}\n\n` : `🔗 ${linkToUse}\n\n`;
      }

      hashtagString = hashtags.join(' ');
      while ((tweet + hashtagString).length > 280 && hashtags.length > 0) {
        hashtags.pop();
        hashtagString = hashtags.join(' ');
      }
      tweet += hashtagString;

      if (tweet.length > 280) {
        tweet = tweet.substring(0, 277) + '...';
      }
    }

    return tweet.trim();
  }

  /**
   * Format message for Reddit
   */
  formatForReddit(productInfo) {
    let title = productInfo.productName || 'Product Restock Alert';
    if (!title.toLowerCase().includes('restock')) {
      title += ' - Restock';
    }
    if (title.length > 300) {
      title = title.substring(0, 297) + '...';
    }

    let body = '';
    if (productInfo.price) body += `**Price:** ${productInfo.price}\n\n`;
    if (productInfo.link)  body += `**Link:** ${productInfo.link}\n\n`;
    body += '---\n\n';
    body += '*Track more restocks at [TCGWatchtower.com](https://tcgwatchtower.com)*';

    return { title, body };
  }

  /**
   * Format message for Website API
   */
  formatForWebsite(productInfo, messageId, channelId) {
    return {
      product_name: productInfo.productName || 'Unknown Product',
      price: productInfo.price || null,
      affiliate_link: productInfo.affiliateLink || productInfo.link || null,
      image_url: productInfo.images.length > 0 ? productInfo.images[0].url : null,
      timestamp: new Date().toISOString(),
      source_message_id: messageId,
      source_channel_id: channelId,
      raw_content: productInfo.rawContent,
    };
  }

  /**
   * Validate that product info is sufficient for posting
   */
  isValidProductInfo(productInfo) {
    if (productInfo.isPokemonCenterQueue) return true;

    if (!productInfo.productName && !productInfo.link) {
      logger.warning('Product info validation failed: missing product name and link');
      return false;
    }

    return true;
  }

  /**
   * Check if message is a Pokemon Center queue alert
   */
  isPokemonCenterQueueAlert(message, productInfo) {
    const content = (message.content || '').toLowerCase();
    const embedContent = productInfo.rawContent?.toLowerCase() || '';
    const combinedContent = content + ' ' + embedContent;

    const queueKeywords = ['queue', 'security', 'waiting room', 'queue is live', 'security is up', 'queue active'];
    const hasQueueKeyword = queueKeywords.some(keyword => combinedContent.includes(keyword));

    const isPokemonCenterChannel =
      config.discord.pokemonCenterChannelId &&
      message.channel.id === config.discord.pokemonCenterChannelId;

    return hasQueueKeyword && isPokemonCenterChannel;
  }

  /**
   * Format Pokemon Center queue alert for Twitter
   */
  formatPokemonCenterQueueAlert() {
    return `🚨 POKEMON CENTER QUEUE IS LIVE!

The Pokemon Center waiting room/security queue is now active!

Get ready to purchase!

🔗 https://www.pokemoncenter.com

#PokemonCenter #TCGDeals #Queue`;
  }
}

module.exports = new MessageProcessor();
