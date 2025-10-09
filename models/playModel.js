const cheerio = require('cheerio');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const Config = require('../utils/config');
const DataProcessor = require('../utils/dataProcessor');
const Animepahe = require('../scrapers/animepahe');
const { getJsVariable } = require('../utils/jsParser');
const { CustomError } = require('../middleware/errorHandler');

class PlayModel {
    static async getStreamingLinks(id, episodeId) {
        const results = await Animepahe.getData('play', { id, episodeId }, false);
        if (!results) throw new CustomError('Failed to fetch streaming data', 503);

        if (typeof results === 'object' && !results.data) results.data = [];
        if (results.data) return DataProcessor.processApiData(results);

        return this.scrapePlayPage(id, episodeId, results);
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
            if (!script.includes('eval(')) continue;
            console.log('Evaluating candidate script via vm sandbox...');

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
                    // if video element has src set later, capture it
                    if (m && m.src && typeof m.src === 'string' && m.src.includes('.m3u8')) captured.add(m.src);
                    } catch (e) {}
                },
                on: () => {},
                };
            };
            Hls.isSupported = () => true;

            // also intercept assignments to video.src by monitoring JSDOM element after script
            // Sandbox
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

            // Run script and also try to unwrap one level of nested evals if found
            try {
                // Run once
                vm.runInContext(script, sandbox, { timeout: 2000 });
            } catch (err) {
                console.log('Eval failed:', err && err.message);
            }

            // Some pages embed further eval inside strings. Try to detect `eval(function(...` pattern and run inner body(s)
            // search the script text for eval( and then try to extract common packed patterns. This is best-effort.
            const innerEvalBodies = [];
            const packedMatch = script.match(/eval\((function[\s\S]*?)\)\s*;?/i);
            if (packedMatch && packedMatch[1]) innerEvalBodies.push(packedMatch[1]);
            // also check for common eval\(\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('[\s\S]*?'\)\)
            const genericMatches = [...script.matchAll(/eval\(([\s\S]*?)\)\s*;?/gi)];
            for (const gm of genericMatches) {
                if (gm[1] && !innerEvalBodies.includes(gm[1])) innerEvalBodies.push(gm[1]);
            }

            for (const body of innerEvalBodies) {
                try {
                // attempt to run inner body directly
                vm.runInContext(body, sandbox, { timeout: 1500 });
                } catch (err) {
                // ignore errors: many packed scripts expect DOM APIs we stubbed
                }
            }

            // After execution, check multiple places for m3u8
            // 1) captured set from Plyr/Hls
            if (captured.size) {
                const arr = Array.from(captured);
                // return first
                console.log('Resolved m3u8 (captured):', arr[0]);
                return [{ url: arr[0] || null, isM3U8: arr[0].includes('.m3u8') || false }];
            }

            // 2) check video element src
            try {
                const vsrc = videoEl && videoEl.src;
                const found = findM3u8(vsrc);
                if (found) {
                console.log('Resolved m3u8 (video.src):', found);
                return [{ url: found, isM3U8: found.includes('.m3u8') || false }];
                }
            } catch (e) { /* ignore */ }

            // 3) check sandbox.window / sandbox.document for q or other variables
            try {
                const pkg = JSON.stringify(sandbox);
                const found = findM3u8(pkg);
                if (found) {
                console.log('Resolved m3u8 (sandbox JSON):', found);
                return [{ url: found, isM3U8: found.includes('.m3u8') || false }];
                }
            } catch (e) { /* ignore */ }

            // 4) finally scan the original script text for direct m3u8 (rare if obfuscated)
            const fromScript = findM3u8(script);
            if (fromScript) {
                console.log('Resolved m3u8 (script literal):', fromScript);
                return [{ url: fromScript, isM3U8: fromScript.includes('.m3u8') || false }];
            }

            console.log('Could not resolve m3u8 from this script, continuing to next candidate...');
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

    static async getDownloadLinkList($) {
        const downloadLinks = [];
        $('#pickDownload a').each((index, element) => {
            const link = $(element).attr('href');
            if (!link) return;

            const fullText = $(element).text().trim();

            const normalized = fullText
                .replace(/\u00A0/g, ' ')
                .replace(/Â·/g, '·')
                .replace(/\s+/g, ' ')
                .trim();

            const parts = normalized.split('·').map(p => p.trim()).filter(Boolean);

            let fansub = null;
            let filesize = null;
            let isDub = false;
            const quality = fullText; // preserve original label for backwards compatibility

            const parseSizeAndEng = (text) => {
                const m = text.match(/(\d+p)(?:\s*\((\d+(?:\.\d+)?(?:MB|GB))\))?(?:\s*(eng))?$/i);
                if (m) {
                    filesize = m[2] || null;
                    isDub = !!m[3];
                }
            };

            if (parts.length === 1) {
                parseSizeAndEng(parts[0]);
            } else if (parts.length >= 2) {
                fansub = parts[0] || null;
                const remainder = parts.slice(1).join(' · ');
                parseSizeAndEng(remainder);
            }

            downloadLinks.push({ url: link || null, fansub, quality, filesize, isDub });
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
        };

        try {
            const resolutions = await this.getResolutionList($);
            const resolutionData = resolutions.map(res => ({
                url: res.url,
                resolution: res.resolution,
                isDub: res.isDub,
                fanSub: res.fanSub,
            }));

            let allSources = [];
            try {
                allSources = await this.processHybridOptimized(id, episodeId, resolutionData);
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

    /*
     * Optimized parallel approach:
     * Process multiple iframe sources in parallel batches. You can increase it to be higher than 2 below for better speed... but not recommended to avoid straining the server
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

        // Process all items (including first) in parallel batches of 2 for better speed
        const maxParallel = 2;
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
            
            // Small delay between batches to be respectful to servers
            if (i + maxParallel < uniqueItems.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
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