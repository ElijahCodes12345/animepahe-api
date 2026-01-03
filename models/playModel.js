const cheerio = require('cheerio');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const Config = require('../utils/config');
const DataProcessor = require('../utils/dataProcessor');
const Animepahe = require('../scrapers/animepahe');
const { getJsVariable } = require('../utils/jsParser');
const { CustomError } = require('../middleware/errorHandler');
const UrlConverter = require('../utils/urlConverter');

class PlayModel {
    static async getStreamingLinks(id, episodeId, includeDownloads = true) {
        const results = await Animepahe.getData('play', { id, episodeId }, false);
        if (!results) throw new CustomError('Failed to fetch streaming data', 503);

        if (typeof results === 'object' && !results.data) results.data = [];
        if (results.data) return DataProcessor.processApiData(results);

        return this.scrapePlayPage(id, episodeId, results, includeDownloads);
    }

    static async scrapeIframe(id, episodeId, url) {
        const html = await Animepahe.fetchIframeHtml(id, episodeId, url);
        if (!html) throw new CustomError('Failed to fetch iframe data', 503);

        return this.extractSources(html, url);
    }


    static async extractSources(html, url = '') {
        const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        if (!scriptMatches.length) {
            console.log('No inline <script> blocks found.');
            return null;
        }
        console.log(`Found ${scriptMatches.length} script tags.`);

        const findM3u8 = (s) => {
            if (!s) return null;
            const m = s.match(/https?:\/\/[^"'<> \n\r]+\.m3u8[^\s"'<>]*/i);
            return m ? m[0] : null;
        };

        for (const script of scriptMatches) {
            // Optimization: fast regex check before heavy VM execution
            const fromScript = findM3u8(script);
            if (fromScript) {
                return [{ url: fromScript, isM3U8: fromScript.includes('.m3u8') || false }];
            }

            if (!script.includes('eval(')) continue;

            const dom = new JSDOM(`<!DOCTYPE html><video id="player"></video>`);
            const document = dom.window.document;
            const videoEl = document.querySelector('video');

            const captured = new Set();

            const Plyr = function (el, opts) {
                try {
                if (opts && opts.sources && Array.isArray(opts.sources)) {
                    for (const s of opts.sources) {
                    if (s && typeof s.src === 'string' && s.src.includes('.m3u8')) captured.add(s.src);
                    }
                }
                } catch (e) { /* ignore */ }
                return { on: () => {}, };
            };

            const Hls = function (cfg) {
                return {
                loadSource: (src) => {
                    try { if (typeof src === 'string' && src.includes('.m3u8')) captured.add(src); } catch (e) {}
                },
                attachMedia: (m) => {
                    try {
                    if (m && m.src && typeof m.src === 'string' && m.src.includes('.m3u8')) captured.add(m.src);
                    } catch (e) {}
                },
                on: () => {},
                };
            };
            Hls.isSupported = () => true;

            const sandbox = {
                console,
                window: dom.window,
                document: dom.window.document,
                navigator: { userAgent: Config.userAgent },
                location: { href: url },
                Plyr,
                Hls,
                setTimeout,
                clearTimeout,
            };

            vm.createContext(sandbox);

            try {
                vm.runInContext(script, sandbox, { timeout: 2000 });
            } catch (err) {
                // ignore eval errors
            }

            const innerEvalBodies = [];
            const packedMatch = script.match(/eval\((function[\s\S]*?)\)\s*;?/i);
            if (packedMatch && packedMatch[1]) innerEvalBodies.push(packedMatch[1]);
            
            const genericMatches = [...script.matchAll(/eval\(([\s\S]*?)\)\s*;?/gi)];
            for (const gm of genericMatches) {
                if (gm[1] && !innerEvalBodies.includes(gm[1])) innerEvalBodies.push(gm[1]);
            }

            for (const body of innerEvalBodies) {
                try {
                vm.runInContext(body, sandbox, { timeout: 1500 });
                } catch (err) {}
            }

            if (captured.size) {
                const arr = Array.from(captured);
                return [{ url: arr[0] || null, isM3U8: arr[0].includes('.m3u8') || false }];
            }

            try {
                const vsrc = videoEl && videoEl.src;
                const found = findM3u8(vsrc);
                if (found) {
                return [{ url: found, isM3U8: found.includes('.m3u8') || false }];
                }
            } catch (e) {}

            try {
                const pkg = JSON.stringify(sandbox);
                const found = findM3u8(pkg);
                if (found) {
                return [{ url: found, isM3U8: found.includes('.m3u8') || false }];
                }
            } catch (e) {}
        }

        // fallback: try data-src attribute in html (in case)
        const fallback = html.match(/data-src="([^"]+\.m3u8[^"]*)"/i);
        if (fallback) {
            console.log('FOUND data-src m3u8 (fallback):', fallback[1]);
            return [{ url: fallback[1], isM3U8: fallback[1].includes('.m3u8') || false }];
        }

        console.log('Could not resolve m3u8 from any Kwik script.');
        return null;
    }

    static async getDownloadLinkList($, resolveLinks = true) {
        const elements = $('#pickDownload a').get();
        const BATCH_SIZE = 4;
        const BATCH_DELAY = 800;
        
        const processElement = async (element) => {
            const $element = $(element);
            const link = $element.attr('href');
            if (!link) return null;
            
            const fullText = $element.text().trim();
            const normalized = fullText
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            const parts = normalized.split('·').map(p => p.trim()).filter(Boolean);
            
            let fansub = null;
            let filesize = null;
            let isDub = false;
            let resolution = null;
            const quality = fullText;
            
            const parseSizeAndEng = (text) => {
                const m = text.match(/(\d+)p(?:\s*\((\d+(?:\.\d+)?(?:MB|GB))\))?(?:\s*(eng))?$/i);
                if (m) {
                    resolution = m[1];
                    filesize = m[2] || "Unknown";
                    isDub = !!m[3];
                }
            };
            
            if (parts.length === 1) {
                parseSizeAndEng(parts[0]);
            } else if (parts.length >= 2) {
                fansub = parts[0];
                parseSizeAndEng(parts.slice(1).join(' · '));
            }

            // Correction for specific known fansubs or patterns if needed
            // (Standard pahe format is quite consistent)

            // Normalize isDub check - sometimes "Eng Dub" is in the title, not just the quality string
            // But we rely on the list item text usually.
            
            const item = {
                fansub,
                quality,
                resolution,
                filesize,
                isDub,
                pahe: link,
                download: null
            };

            if (!resolveLinks) {
                return item;
            }
            
            try {
                const directDownloadLink = await this.getDownloadLinks(link);
                item.download = directDownloadLink.downloadUrl;
                return item;
            } catch (error) {
                console.error(`Failed to get direct download for ${link}: ${error.message}`);
                return item;
            }
        };
        
        // If not resolving links, we don't need batching or delays
        if (!resolveLinks) {
             const results = await Promise.all(elements.map(processElement));
             return results.filter(r => r);
        }

        const results = [];
        for (let i = 0; i < elements.length; i += BATCH_SIZE) {
            const batch = elements.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.allSettled(batch.map(processElement));
            
            results.push(...batchResults
                .filter(r => r.status === 'fulfilled' && r.value)
                .map(r => r.value)
            );
            
            if (i + BATCH_SIZE < elements.length) {
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }
        return results;
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

    static async getDownloadLinks(url) {
        const results = await Animepahe.getData('download', { url }, false);
        return results;
    }

    static async scrapePlayPage(id, episodeId, pageHtml, includeDownloads = true) {
        const [session, provider] = ['session', 'provider'].map(v => getJsVariable(pageHtml, v) || null);
        if (!session || !provider) throw new CustomError('Episode not found', 404);

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
                myanimelist: $('meta[name="myanimelist"]').attr('content') || null,
            },
            session,
            provider,
            episode: $('.episode-menu #episodeMenu').text().trim().replace(/\D/g, ''),
            anime_title: $('div.title-wrapper > h1 > span').text().trim().replace(/^Watch\s+/i, '').replace(/\s+-\s+\d+\s+Online$/i, '') || $('h1').text().trim().replace(/^Watch\s+/i, '').replace(/\s+-\s+\d+\s+Online$/i, '').replace(/ Episode \d+$/, ''),
        };

        try {
            const resolutions = await this.getResolutionList($);
            const resolutionData = resolutions.map(res => ({
                url: res.url,
                resolution: res.resolution,
                isDub: res.isDub,
                fanSub: res.fanSub,
            }));

            // Process sources and downloads
            
            // 1. Fetch sources (m3u8)
            const allSources = await this.processHybridOptimized(id, episodeId, resolutionData);
            
            // 2. Prepare fast download links map
            // We create a map of "resolution-fansub-isDub" key to the fast download URL
            const fastDownloadMap = new Map();
            
            const processedSources = allSources.flat().map(source => {
                if (includeDownloads && source.url && source.isM3U8) {
                    const downloadUrl = UrlConverter.buildDownloadUrl(
                        source.url,
                        Config.iframeBaseUrl,
                        {
                            animeTitle: playInfo.anime_title,
                            episode: playInfo.episode,
                            resolution: source.resolution,
                            fansub: source.fanSub,
                            isDub: source.isDub
                        }
                    );
                    
                    if (downloadUrl) {
                        source.download = downloadUrl;
                        // Key format: "720-SubsPlease-false"
                        const key = `${source.resolution}-${source.fanSub || 'default'}-${source.isDub}`;
                        fastDownloadMap.set(key, downloadUrl);
                    }
                }
                return source;
            });
            
            playInfo.sources = processedSources;

            // 3. Handle Downloads List
            if (includeDownloads) {
                // Fetch the metadata list (without resolving links) - FAST
                const metadataList = await this.getDownloadLinkList($, false);
                
                // Hydrate the metadata list with our fast links
                const finalDownloads = metadataList.map(item => {
                    const key = `${item.resolution}-${item.fansub || 'default'}-${item.isDub}`;
                    const fastLink = fastDownloadMap.get(key);
                    
                    if (fastLink) {
                        item.download = fastLink;
                    }
                    return item;
                });
                
                // Filter out items that still don't have a download link? 
                // Alternatively, we could try to resolve the remaining ones sequentially if needed.
                // For now, let's return what we have. Most should match.
                
                playInfo.downloads = finalDownloads;
                
                console.log(`Matched ${finalDownloads.filter(d => d.download).length}/${metadataList.length} download links locally.`);
                
            } else {
                playInfo.downloads = [];
            }
        } catch (error) {
            console.error('Error in scrapePlayPage:', error);
            playInfo.sources = playInfo.sources || [];
            playInfo.downloads = playInfo.downloads || [];
        }

        return playInfo;
    }

    /*
     * Optimized parallel approach:
     * Process multiple iframe sources in parallel batches. Increased to 3 for better speed.
     */
    static async processHybridOptimized(id, episodeId, items) {
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

        console.log(`Starting parallel processing of ${uniqueItems.length} iframe sources...`);

        if (uniqueItems.length === 0) {
            return results;
        }

        // Increased from 2 to 3 for better parallelization
        const maxParallel = 3;
        for (let i = 0; i < uniqueItems.length; i += maxParallel) {
            const batch = uniqueItems.slice(i, i + maxParallel);
            
            console.log(`Processing batch ${Math.floor(i / maxParallel) + 1}/${Math.ceil(uniqueItems.length / maxParallel)} with ${batch.length} items...`);
            
            const batchPromises = batch.map(async (data) => {
                try {
                    const sources = await Animepahe.scrapeIframe(id, episodeId, data.url);
                    
                    return sources.map(source => ({
                        ...source,
                        resolution: data.resolution,
                        isDub: data.isDub,
                        fanSub: data.fanSub,
                    }));
                } catch (err) {
                    console.error(`Failed to process ${data.resolution}:`, err.message);
                    return []; // Return empty array for failed items
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            
            // Reduced delay from 500ms to 300ms
            if (i + maxParallel < uniqueItems.length) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        const successCount = results.filter(r => r && r.length > 0).length;
        console.log(`Parallel processing complete: ${successCount}/${uniqueItems.length} iframe sources processed successfully`);
        return results;
    }

    // Sequential fallback processing when needed.
    static async processSequentialFallback(id, episodeId, items, delayMs = 1500) {
        console.log('Switching to sequential fallback processing for remaining iframe sources...');
        const results = [];

        for (let i = 0; i < items.length; i++) {
            const data = items[i];
            try {
                const sources = await Animepahe.scrapeIframe(id, episodeId, data.url);

                const sourcesWithMeta = sources.map(source => ({
                    ...source,
                    resolution: data.resolution,
                    isDub: data.isDub,
                    fanSub: data.fanSub,
                }));
                results.push(sourcesWithMeta);

                if (i < items.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            } catch (err) {
                console.error(`Failed ${data.resolution}:`, err.message);
            }
        }

        return results;
    }

    // Backwards-compatibility wrappers
    static async processSequential(id, episodeId, items, delayMs = 2000) {
        return this.processHybridOptimized(id, episodeId, items);
    }

    static async processBatch(id, episodeId, items, batchSize = 3, delayMs = 500) {
        return this.processHybridOptimized(id, episodeId, items);
    }
}

module.exports = PlayModel;