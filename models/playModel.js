const cheerio = require('cheerio');
const DataProcessor = require('../utils/dataProcessor');
const Animepahe = require('../scrapers/animepahe');
const { getJsVariable } = require('../utils/jsParser');
const { CustomError } = require('../middleware/errorHandler');

class PlayModel {
    static async getStreamingLinks(id, episodeId) {
        const results = await Animepahe.getData("play", { id, episodeId }, false);
        
        if (!results) {
            throw new CustomError('Failed to fetch streaming data', 503);
        }

        if (typeof results === 'object' && !results.data) {
            results.data = [];
        }    
        
        if (results.data) {
            return DataProcessor.processApiData(results);
        }
        
        return this.scrapePlayPage(id, episodeId, results);
    }

    static async scrapeIframe(id, episodeId, url) {
        const results = await Animepahe.getData("iframe", { id, episodeId, url }, false);
        if (!results) {
            throw new CustomError('Failed to fetch iframe data', 503);
        }

        const execResult = /(eval)(\(f.*?)(\n<\/script>)/s.exec(results);
        if (!execResult) {
            throw new CustomError('Failed to extract source from iframe', 500);
        }

        const source = eval(execResult[2].replace('eval', '')).match(/https.*?m3u8/);
        if (!source) {
            throw new CustomError('Failed to extract m3u8 URL', 500);
        }

        return [{
            url: source[0] || null,
            isM3U8: source[0].includes('.m3u8') || false,
        }];
    }

    static async getDownloadLinkList($) {
        const downloadLinks = [];
        
        $('#pickDownload a').each((index, element) => {
            const link = $(element).attr('href');
            if (link) {
                const fullText = $(element).text().trim();
                const match = fullText.match(/(?:(\w+)\s*·\s*(\d+p)\s*\((\d+(?:\.\d+)?(?:MB|GB))\))(?:\s*(eng))?/i);
                
                downloadLinks.push({
                    url: link || null,
                    fansub: match ? match[1] : null,
                    quality: match ? match[2] : fullText,
                    filesize: match ? match[3] : null,
                    isDub: match && match[4] ? true : false
                });
            }
        });

        return downloadLinks;
    }

    static async getResolutionList($) {
        const resolutions = [];
        
        $('#resolutionMenu button').each((index, element) => {
            const link = $(element).attr('data-src');
            const resolution = $(element).attr('data-resolution');
            const audio = $(element).attr('data-audio');
            if (link) {
                resolutions.push({
                    url: link || null,
                    resolution: resolution || null,
                    isDub: (audio && audio.toLowerCase() === 'eng') || false,
                    fanSub: $(element).attr('data-fansub') || null,
                });
            }
        });

        return resolutions;
    }
    
    static async scrapePlayPage(id, episodeId, pageHtml) {
        const [ session, provider ] = ['session', 'provider'].map(v => getJsVariable(pageHtml, v) || null);

        if (!session || !provider) {
            throw new CustomError('Episode not found', 404);
        }

        const $ = cheerio.load(pageHtml);        
        
        const playInfo = {
            ids: {
                animepahe_id: parseInt($('meta[name="id"]').attr('content'), 10) || null,
                mal_id: parseInt($('meta[name="anidb"]').attr('content'), 10) || null,
                anilist_id: parseInt($('meta[name="anilist"]').attr('content'), 10) || null,
                anime_planet_id: parseInt($('meta[name="anime-planet"]').attr('content'), 10) || null,
                ann_id: parseInt($('meta[name="ann"]').attr('content'), 10) || null,
                anilist: $('meta[name="anilist"]').attr('content') || null,
                anime_planet: $('meta[name="anime-planet"]').attr('content') || null,
                ann: $('meta[name="ann"]').attr('content') || null,
                kitsu: $('meta[name="kitsu"]').attr('content') || null,
                myanimelist: $('meta[name="myanimelist"]').attr('content') || null
            },
            session,
            provider,
            episode: $('.episode-menu #episodeMenu').text().trim().replace(/\D/g, ''),
        };

        try {
            const resolutions = await this.getResolutionList($);
            const resolutionData = resolutions.map(res => ({
                url: res.url,
                resolution: res.resolution,
                isDub: res.isDub,
                fanSub: res.fanSub
            }));

            let allSources = [];
            try {
                const isVercel = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
                
                if (isVercel) {
                    console.log('Running on Vercel - using sequential processing');
                    allSources = await this.processSequential(id, episodeId, resolutionData);
                } else {
                    console.log('Running locally - using batch processing');
                    allSources = await this.processBatch(id, episodeId, resolutionData);
                }
            } catch (iframeError) {
                console.error('Error in scrapeIframe, returning partial data:', iframeError);
                allSources = []; 
            }

            playInfo.sources = allSources.flat();
            playInfo.downloadLinks = await this.getDownloadLinkList($);
        } catch (error) {
            console.error('Error in scrapePlayPage:', error);
            playInfo.sources = playInfo.sources || [];
            playInfo.downloadLinks = playInfo.downloadLinks || [];
        }

        return playInfo;
    }

    // sequential processing for Vercel/serverless environments
    static async processSequential(id, episodeId, items, delayMs = 2000) {
        const results = [];
        const seenUrls = new Set();
        
        const uniqueItems = items.filter(item => {
            if (seenUrls.has(item.url)) {
                console.log('Skipping duplicate URL:', item.url);
                return false;
            }
            seenUrls.add(item.url);
            return true;
        });
        
        console.log(`Processing ${uniqueItems.length} items sequentially for better stability`);
        
        // Process first item to break Cloudflare
        if (uniqueItems.length > 0) {
            console.log('🔓 Breaking Cloudflare with first resolution...');
            const firstItem = uniqueItems[0];
            try {
                const sources = await Animepahe.scrapeIframe(id, episodeId, firstItem.url);
                const sourcesWithMeta = sources.map(source => ({
                    ...source,
                    resolution: firstItem.resolution,
                    isDub: firstItem.isDub,
                    fanSub: firstItem.fanSub
                }));
                results.push(sourcesWithMeta);
                console.log('✅ Cloudflare broken, cookies extracted');
                
                // Wait before next request
                if (uniqueItems.length > 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            } catch (err) {
                console.error('❌ Failed to process first resolution:', err.message);
                return []; 
            }
        }

        // Process remaining items with fast cookie method
        for (let i = 1; i < uniqueItems.length; i++) {
            const data = uniqueItems[i];
            try {
                let sources;
                if (Animepahe.cloudflareSessionCookies) {
                    try {
                        console.log(`Processing ${data.resolution} with fast cookie method...`);
                        sources = await Animepahe.scrapeIframeWithExtractedCookies(data.url);
                        console.log('✅ Used fast cookie method for:', data.resolution);
                    } catch (cookieError) {
                        console.warn('Cookie method failed, falling back to full scrape:', cookieError.message);
                        sources = await Animepahe.scrapeIframe(id, episodeId, data.url);
                    }
                } else {
                    sources = await Animepahe.scrapeIframe(id, episodeId, data.url);
                }
                
                const sourcesWithMeta = sources.map(source => ({
                    ...source,
                    resolution: data.resolution,
                    isDub: data.isDub,
                    fanSub: data.fanSub
                }));
                results.push(sourcesWithMeta);
                
                // Wait between requests
                if (i < uniqueItems.length - 1) {
                    const delay = Animepahe.cloudflareSessionCookies ? delayMs / 2 : delayMs;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (err) {
                console.error(`Failed to scrape iframe for ${data.resolution}:`, err.message);
            }
        }

        console.log(`✅ Processed ${results.length} resolution sources total`);
        return results;
    }

    // Original batch processing for local environments
    static async processBatch(id, episodeId, items, batchSize = 3, delayMs = 500) {
        const results = [];
        const seenUrls = new Set(); 
        
        const uniqueItems = items.filter(item => {
            if (seenUrls.has(item.url)) {
                console.log('Skipping duplicate URL:', item.url);
                return false;
            }
            seenUrls.add(item.url);
            return true;
        });
        
        console.log(`Processing ${uniqueItems.length} unique items with cookie-sharing optimization`);
        
        // Process first item with browser to break Cloudflare and extract cookies
        if (uniqueItems.length > 0) {
            console.log('🔓 Breaking Cloudflare with first resolution...');
            const firstItem = uniqueItems[0];
            try {
                await Animepahe.scrapeIframe(id, episodeId, firstItem.url);
                console.log('✅ Cloudflare broken, cookies extracted');
            } catch (err) {
                console.error('❌ Failed to process first resolution:', err.message);
                return []; 
            }
        }

        // Now process ALL items (including the first) using the fast cookie method
        for (let i = 0; i < uniqueItems.length; i += batchSize) {
            const batch = uniqueItems.slice(i, i + batchSize);
            const batchPromises = batch.map(async (data) => {
                try {
                    let sources;
                    if (Animepahe.cloudflareSessionCookies) {
                        try {
                            console.log('Fetching iframe for:', data.url);
                            sources = await Animepahe.scrapeIframeWithExtractedCookies(data.url);
                            console.log('✅ Used fast cookie method for:', data.resolution);
                        } catch (cookieError) {
                            console.warn('Cookie method failed, falling back to full scrape:', cookieError.message);
                            sources = await Animepahe.scrapeIframe(id, episodeId, data.url);
                        }
                    } else {
                        sources = await Animepahe.scrapeIframe(id, episodeId, data.url);
                    }
                    return sources.map(source => ({
                        ...source,
                        resolution: data.resolution,
                        isDub: data.isDub,
                        fanSub: data.fanSub
                    }));
                } catch (err) {
                    console.error('Failed to scrape iframe for:', data.url, err.message);
                    return [];
                }
            });
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            if (i + batchSize < uniqueItems.length) {
                const delay = Animepahe.cloudflareSessionCookies ? delayMs / 2 : delayMs;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        console.log(`✅ Processed ${results.length} resolution sources total`);
        return results;
    }
}

module.exports = PlayModel;