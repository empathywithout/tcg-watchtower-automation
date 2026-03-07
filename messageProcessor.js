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
      const embed = message.embeds[0]; // Use first embed
      
      // Extract title as product name
      if (embed.title) {
        productInfo.productName = embed.title;
      }
      
      // Extract description for additional info
      if (embed.description) {
        productInfo.rawContent = embed.description;
      }
      
      // Extract fields (SKU, Price, Links, etc.)
      if (embed.fields && embed.fields.length > 0) {
        embed.fields.forEach(field => {
          const fieldName = field.name.toLowerCase();
          const fieldValue = field.value;
          
          // Extract SKU
          if (fieldName.includes('sku')) {
            productInfo.sku = fieldValue.trim();
          }
          
          // Extract Price
          if (fieldName.includes('price')) {
            const priceMatch = fieldValue.match(/\$\s*(\d+\.?\d*)/);
            if (priceMatch) {
              productInfo.price = `$${priceMatch[1]}`;
            }
          }
          
          // Extract Links
          if (fieldName.includes('link')) {
            // Extract multiple links from the field
            const linkMatches = fieldValue.match(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g);
            if (linkMatches) {
              // Parse markdown links: [eBay](http://...)
              const firstLink = linkMatches[0];
              const urlMatch = firstLink.match(/\((https?:\/\/[^\)]+)\)/);
              if (urlMatch) {
                productInfo.link = urlMatch[1];
              }
              
              // Store all links for potential use
              productInfo.allLinks = linkMatches.map(link => {
                const match = link.match(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/);
                if (match) {
                  return { name: match[1], url: match[2] };
                }
                return null;
              }).filter(Boolean);
            } else {
              // Try direct URL extraction
              const urlMatch = fieldValue.match(/https?:\/\/[^\s\)]+/);
              if (urlMatch) {
                productInfo.link = urlMatch[0];
              }
            }
          }
        });
      }
      
      // Extract thumbnail image
      if (embed.thumbnail && embed.thumbnail.url) {
        productInfo.images.push({
          url: embed.thumbnail.url,
          name: 'thumbnail',
        });
      }
      
      // Extract main image
      if (embed.image && embed.image.url) {
        productInfo.images.push({
          url: embed.image.url,
          name: 'embedded_image',
        });
      }
      
      // Extract footer info (like "TCG Watchtower Monitors • Target • 11:27:00...")
      if (embed.footer && embed.footer.text) {
        const footerText = embed.footer.text;
        // Extract timestamp or source info if needed
        productInfo.source = footerText;
      }
    }

    // PRIORITY 2: Extract from plain text content (fallback)
    if (!productInfo.productName) {
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
    }

    // Extract price from content if not found in embed
    if (!productInfo.price) {
      const priceMatch = content.match(/\$\s*(\d+\.?\d*)/);
      if (priceMatch) {
        productInfo.price = `$${priceMatch[1]}`;
      }
    }

    // Extract links from content if not found in embed
    if (!productInfo.link) {
      const linkMatches = content.match(/https?:\/\/[^\s]+/g);
      if (linkMatches && linkMatches.length > 0) {
        productInfo.link = linkMatches[0];
      }
    }

    // Extract images from attachments
    if (message.attachments && message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          productInfo.images.push({
            url: attachment.url,
            name: attachment.name,
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
    
    // Add restock alert indicator
    tweet += '🚨 RESTOCK\n\n';

    // Add product name
    if (productInfo.productName) {
      let productName = productInfo.productName;
      // Clean up product name
      productName = productName
        .replace(/Item Restocked/i, '')
        .replace(/Restock Alert/i, '')
        .trim();
      
      tweet += productName;
    } else {
      tweet += 'New Product Available';
    }

    tweet += '\n\n';

    // Add price
    if (productInfo.price) {
      tweet += `💰 ${productInfo.price}\n\n`;
    }

    // Add link (prefer first link from allLinks or use link)
    let linkToUse = productInfo.link;
    
    // If we have multiple links, prefer certain retailers
    if (productInfo.allLinks && productInfo.allLinks.length > 0) {
      // Prefer order: Amazon, Target, Walmart, eBay, then others
      const preferred = ['amazon', 'target', 'walmart'];
      const preferredLink = productInfo.allLinks.find(l => 
        preferred.some(p => l.name.toLowerCase().includes(p))
      );
      
      if (preferredLink) {
        linkToUse = preferredLink.url;
        tweet += `🛒 ${preferredLink.name}: ${linkToUse}\n\n`;
      } else {
        linkToUse = productInfo.allLinks[0].url;
        tweet += `🔗 ${linkToUse}\n\n`;
      }
    } else if (linkToUse) {
      tweet += `🔗 ${linkToUse}\n\n`;
    }

    // Add hashtags
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

    // Final length check - if still too long, trim product name
    if (tweet.length > 280) {
      // Rebuild with shorter product name
      const maxProductNameLength = 100;
      let shortProductName = productInfo.productName || 'Product';
      if (shortProductName.length > maxProductNameLength) {
        shortProductName = shortProductName.substring(0, maxProductNameLength) + '...';
      }
      
      tweet = '🚨 RESTOCK\n\n' + shortProductName + '\n\n';
      if (productInfo.price) {
        tweet += `💰 ${productInfo.price}\n\n`;
      }
      if (linkToUse) {
        tweet += `🔗 ${linkToUse}\n\n`;
      }
      
      // Try hashtags again
      hashtagString = hashtags.join(' ');
      while ((tweet + hashtagString).length > 280 && hashtags.length > 0) {
        hashtags.pop();
        hashtagString = hashtags.join(' ');
      }
      tweet += hashtagString;
      
      // Final trim if still needed
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
