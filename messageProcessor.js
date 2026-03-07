const logger = require('./logger');
const { config } = require('./config');

class MessageProcessor {
  /**
   * Extract product information from Discord message
   */
  extractProductInfo(message) {
    const content = message.content;
    const lines = content.split('\n').filter(line => line.trim());
    
    const productInfo = {
      rawContent: content,
      productName: null,
      price: null,
      link: null,
      images: [],
      emojis: this.extractEmojis(content),
      hashtags: this.extractHashtags(content),
    };

    // Extract product name (usually after "RESTOCK" or first meaningful line)
    for (const line of lines) {
      const cleanLine = line.replace(/[🚨⚡️✨💎]/g, '').trim();
      if (cleanLine && !cleanLine.startsWith('http') && !cleanLine.startsWith('$') && 
          !cleanLine.toLowerCase().includes('retail') && 
          !cleanLine.toLowerCase().includes('grab it') &&
          !cleanLine.toLowerCase().includes('track more')) {
        if (!productInfo.productName && cleanLine.length > 5) {
          productInfo.productName = cleanLine;
        }
      }
    }

    // Extract price
    const priceMatch = content.match(/\$\s*(\d+\.?\d*)/);
    if (priceMatch) {
      productInfo.price = `$${priceMatch[1]}`;
    }

    // Extract links
    const linkMatches = content.match(/https?:\/\/[^\s]+/g);
    if (linkMatches && linkMatches.length > 0) {
      productInfo.link = linkMatches[0]; // First link is usually the affiliate link
    }

    // Extract images from attachments
    if (message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          productInfo.images.push({
            url: attachment.url,
            name: attachment.name,
          });
        }
      });
    }

    // Extract embedded images
    if (message.embeds.length > 0) {
      message.embeds.forEach(embed => {
        if (embed.image) {
          productInfo.images.push({
            url: embed.image.url,
            name: 'embedded_image',
          });
        }
        if (embed.thumbnail) {
          productInfo.images.push({
            url: embed.thumbnail.url,
            name: 'thumbnail',
          });
        }
      });
    }

    logger.debug('Extracted product info', productInfo);
    return productInfo;
  }

  /**
   * Extract emojis from text
   */
  extractEmojis(text) {
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
    return text.match(emojiRegex) || [];
  }

  /**
   * Extract hashtags from text
   */
  extractHashtags(text) {
    const hashtagRegex = /#[\w]+/g;
    return text.match(hashtagRegex) || [];
  }

  /**
   * Format message for Twitter (280 char limit)
   */
  formatForTwitter(productInfo) {
    let tweet = '';
    
    // Add alert emoji
    if (productInfo.emojis.includes('🚨')) {
      tweet += '🚨 ';
    }

    // Add product name
    if (productInfo.productName) {
      let productName = productInfo.productName;
      // Shorten common phrases
      productName = productName
        .replace(/is back in stock/i, 'back in stock')
        .replace(/RESTOCK ALERT/i, '')
        .trim();
      
      tweet += productName;
    } else {
      tweet += 'RESTOCK ALERT';
    }

    tweet += '\n\n';

    // Add price
    if (productInfo.price) {
      tweet += `${productInfo.price}\n\n`;
    }

    // Add link
    if (productInfo.link) {
      tweet += `${productInfo.link}\n\n`;
    }

    // Add hashtags from original message or default hashtags
    let hashtags = productInfo.hashtags.length > 0 
      ? productInfo.hashtags 
      : config.defaultHashtags;
    
    // Ensure we don't exceed 280 characters
    let hashtagString = hashtags.join(' ');
    
    // Check length and trim if necessary
    while ((tweet + hashtagString).length > 280 && hashtags.length > 0) {
      hashtags.pop();
      hashtagString = hashtags.join(' ');
    }

    tweet += hashtagString;

    // Final length check
    if (tweet.length > 280) {
      tweet = tweet.substring(0, 277) + '...';
    }

    return tweet.trim();
  }

  /**
   * Format message for Reddit
   */
  formatForReddit(productInfo) {
    // Title: Product name with "Restock" if not already included
    let title = productInfo.productName || 'Product Restock Alert';
    if (!title.toLowerCase().includes('restock')) {
      title += ' - Restock';
    }

    // Limit title to 300 characters (Reddit's limit)
    if (title.length > 300) {
      title = title.substring(0, 297) + '...';
    }

    // Body
    let body = '';
    
    if (productInfo.price) {
      body += `**Price:** ${productInfo.price}\n\n`;
    }

    if (productInfo.link) {
      body += `**Link:** ${productInfo.link}\n\n`;
    }

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
      affiliate_link: productInfo.link || null,
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
    // At minimum, we need either a product name or a link
    if (!productInfo.productName && !productInfo.link) {
      logger.warning('Product info validation failed: missing product name and link');
      return false;
    }

    return true;
  }
}

module.exports = new MessageProcessor();
