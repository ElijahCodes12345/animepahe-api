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

        console.log("PRESENT 1");
        
        return this.scrapePlayPage(results);
    }

    static async scrapeIframe(url) {
        const results = await Animepahe.getData("iframe", { url }, false);
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
        console.log("PRESENT 2.7");
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

        if (downloadLinks.length === 0) {
            return [];
        }

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

        if (resolutions.length === 0) {
            return []; 
        }

        console.log("PRESENT 2.5");

        return resolutions;
    }
    
    static async scrapePlayPage(pageHtml) {
        const [ session, provider ] = ['session', 'provider'].map(v => getJsVariable(pageHtml, v) || null);

        if (!session || !provider) {
            throw new CustomError('Episode not found', 404);
        }

        console.log("PRESENT 2");

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
            
            const allSources = await this.processBatch(resolutionData);
            playInfo.sources = allSources.flat();

            playInfo.downloadLinks = await this.getDownloadLinkList($);
        } catch (error) {
            console.error('Error in scrapePlayPage:', error);
            throw new CustomError('Failed to scrape play page data', 500);
        }

        console.log("PRESENT 5");

        return playInfo;
    }

    static async processBatch(items, batchSize = 2, delayMs = 1000) {
        console.log("PRESENT 3");
        const results = [];
        
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            const batchPromises = batch.map(async (data) => {
                const sources = await this.scrapeIframe(data.url);
                return sources.map(source => ({
                    ...source,
                    resolution: data.resolution,
                    isDub: data.isDub,
                    fanSub: data.fanSub
                }));
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            // delay between batches
            if (i + batchSize < items.length) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        console.log("PRESENT 4");
        
        return results;
    }
}

module.exports = PlayModel;