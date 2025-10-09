const fs = require('fs').promises;
const path = require('path');
const Config = require('../utils/config');
const RequestManager = require("../utils/requestManager");
const { launchBrowser } = require('../utils/browser');
const { CustomError } = require('../middleware/errorHandler');
const os = require('os');
const { config } = require('dotenv');

class Animepahe {
    constructor() {
        // Use /tmp directory for Vercel
        this.cookiesPath = path.join('/tmp', 'cookies.json');
        this.cookiesRefreshInterval = 14 * 24 * 60 * 60 * 1000; // 14 days
        this.isRefreshingCookies = false;
        this.activeBrowser = null;
        this.cloudflareSessionCookies = null

        // Add tracking for current kwik request
        this.currentKwikRequest = null;
    }

    async initialize() {
        const needsRefresh = await this.needsCookieRefresh();
        
        if (needsRefresh) {
            await this.refreshCookies();
        }
        
        return true;
    }

    async needsCookieRefresh() {
        try {
            const cookieData = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
            
            if (cookieData?.timestamp) {
                const ageInMs = Date.now() - cookieData.timestamp;
                return ageInMs > this.cookiesRefreshInterval;
            }
            return true;
        } catch (error) {
            return true;
        }
    }        
    
    async refreshCookies() {
        if (this.isRefreshingCookies) return;
        this.isRefreshingCookies = true;

        let browser = this.activeBrowser;

        try {
            if (!browser) {
                browser = await launchBrowser();
                console.log('Browser launched successfully');
                this.activeBrowser = browser; // Store the browser instance
            }

            const context = await browser.newContext();
            const page = await context.newPage();

            // Add stealth plugin
            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) =>
                parameters.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(parameters);
            });

            console.log('Navigating to URL...');
            await page.goto(Config.getUrl('home'), {
                waitUntil: 'networkidle',
                timeout: 30000, 
            });

            // Check for DDoS-Guard challenge
            await page.waitForTimeout(2000);
            const isChallengeActive = await page.$('#ddg-cookie');
            if (isChallengeActive) {
                console.log('Solving DDoS-Guard challenge...');
                await page.waitForSelector('#ddg-cookie', { state: 'hidden', timeout: 30000 });
            }

            const cookies = await context.cookies();
            if (!cookies || cookies.length === 0) {
                throw new CustomError('No cookies found after page load', 503);
            }

            const cookieData = {
                timestamp: Date.now(),
                cookies,
            };

            await fs.mkdir(path.dirname(this.cookiesPath), { recursive: true });
            await fs.writeFile(this.cookiesPath, JSON.stringify(cookieData, null, 2));

            console.log('Cookies refreshed successfully');
        } catch (error) {
            console.error('Cookie refresh error:', error);
            throw new CustomError(`Failed to refresh cookies: ${error.message}`, 503);
        } finally {
            this.isRefreshingCookies = false;
        }
    }

    async getCookies(userProvidedCookies = null) {
        // If user provided cookies directly, use them
        if (userProvidedCookies) {
            if (typeof userProvidedCookies === 'string' && userProvidedCookies.trim()) {
                console.log('Using user-provided cookies');
                Config.setCookies(userProvidedCookies.trim());
                return userProvidedCookies.trim();
            } else {
                throw new CustomError('Invalid user-provided cookies format', 400);
            }
        }

        let cookieData;
        try {
            cookieData = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
        } catch (error) {
            // No cookies: must block and refresh
            await this.refreshCookies();
            cookieData = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
        }

        // Proactive background refresh if cookies are older than 13 days
        const ageInMs = Date.now() - cookieData.timestamp;
        if (ageInMs > (this.cookiesRefreshInterval - 24 * 60 * 60 * 1000) && !this.isRefreshingCookies) {
            this.isRefreshingCookies = true;
            this.refreshCookies()
                .catch(err => console.error('Background cookie refresh failed:', err))
                .finally(() => { this.isRefreshingCookies = false; });
        }

        const cookieHeader = cookieData.cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        Config.setCookies(cookieHeader);
        return cookieHeader;
    }

    async fetchApiData(endpoint, params = {}, userProvidedCookies = null) {
        try {
            const cookieHeader = await this.getCookies(userProvidedCookies);
            const url = new URL(endpoint, Config.getUrl('home')).toString();
            return await RequestManager.fetchApiData(url, params, cookieHeader);
        } catch (error) {
            // Only retry with automatic cookies if user didn't provide cookies
            if (!userProvidedCookies && (error.response?.status === 401 || error.response?.status === 403)) {
                await this.refreshCookies();
                return this.fetchApiData(endpoint, params, userProvidedCookies);
            }
            throw new CustomError(error.message || 'Failed to fetch API data', error.response?.status || 503);
        }
    }

    async fetchAiringData(page = 1, userProvidedCookies = null) {
        return this.fetchApiData('/api', { m: 'airing', page }, userProvidedCookies);
    }

    async fetchSearchData(query, page, userProvidedCookies = null) {
        if (!query) {
            throw new CustomError('Search query is required', 400);
        }
        return this.fetchApiData('/api', { m: 'search', q: query, page }, userProvidedCookies);
    }

    async fetchQueueData(userProvidedCookies = null) {
        return this.fetchApiData('/api', { m: 'queue' }, userProvidedCookies);
    }

    async fetchAnimeRelease(id, sort, page, userProvidedCookies = null) {
        if (!id) {
            throw new CustomError('Anime ID is required', 400);
        }
        return this.fetchApiData('/api', { m: 'release', id, sort, page }, userProvidedCookies);
    }

    // Scraping Methods
    async scrapeAnimeInfo(animeId) {
        if (!animeId) {
            throw new CustomError('Anime ID is required', 400);
        }

        const url = `${Config.getUrl('animeInfo')}${animeId}`;
        const cookieHeader = await this.getCookies();
        const html = await RequestManager.fetch(url, cookieHeader);

        if (!html) {
            throw new CustomError('Failed to fetch anime info', 503);
        }

        return html;
    }

    async scrapeAnimeList(tag1, tag2) {
        const url = tag1 || tag2 
            ? `${Config.getUrl('animeList', tag1, tag2)}`
            : `${Config.getUrl('animeList')}`;

        const cookieHeader = await this.getCookies();
        const html = await RequestManager.fetch(url, cookieHeader);

        if (!html) {
            throw new CustomError('Failed to fetch anime list', 503);
        }

        return html;
    }

    async scrapePlayPage(id, episodeId) {
        if (!id || !episodeId) {
            throw new CustomError('Both ID and episode ID are required', 400);
        }

        const url = Config.getUrl('play', id, episodeId);
        let cookieHeader = await this.getCookies();
        try {
            const html = await RequestManager.fetch(url, cookieHeader);
            console.log(html);
            if (!html) {
                throw new CustomError('Failed to fetch play page', 503);
            }
            return html;
        } catch (error) {
            if (
                error.response?.status === 403 ||
                (error.message && error.message.includes('DDoS-Guard authentication required'))
            ) {
                await this.refreshCookies();
                cookieHeader = await this.getCookies();
                const html = await RequestManager.fetch(url, cookieHeader);
                if (!html) {
                    throw new CustomError('Failed to fetch play page after cookie refresh', 503);
                }
                return html;
            }
            if (error.response?.status === 404) {
                throw new CustomError('Anime or episode not found', 404);
            }
            throw error;
        }
    }

    // Separate method to fetch iframe HTML without circular dependency
    async fetchIframeHtml(id, episodeId, url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        console.log('Initiating iframe HTML fetch:', url);

        // Define all available strategies
        // To add more strategies in the future, add them to this array:
        const allStrategies = [
            () => this.scrapeIframeLight(url),
            // () => this.scrapeIframeHeavy(Config.getUrl('play', id, episodeId), url),
        ];

        // Process strategies in parallel, max 2 at a time
        const maxParallel = 2;
        
        for (let i = 0; i < allStrategies.length; i += maxParallel) {
            const batch = allStrategies.slice(i, i + maxParallel);
            console.log(`Trying ${batch.length} strategies in parallel (batch ${Math.floor(i / maxParallel) + 1}/${Math.ceil(allStrategies.length / maxParallel)})...`);
            
            const promises = batch.map(async (strategy, idx) => {
                try {
                    console.log(`Starting strategy ${i + idx + 1} in parallel...`);
                    const result = await strategy();
                    if (result && result.length > 100) {
                        console.log(`Strategy ${i + idx + 1} succeeded`);
                        return { success: true, result, strategyIndex: i + idx };
                    }
                    return { success: false, error: 'Result too short', strategyIndex: i + idx };
                } catch (error) {
                    console.warn(`Strategy ${i + idx + 1} failed:`, error.message);
                    return { success: false, error: error.message, strategyIndex: i + idx };
                }
            });

            const results = await Promise.all(promises);
            
            // Check if any strategy in the batch succeeded
            const successfulResult = results.find(r => r.success);
            if (successfulResult) {
                return successfulResult.result;
            }
        }

        // If all strategies failed, throw error with all failure details
        throw new CustomError('All iframe fetching strategies failed', 503);
    }

    async scrapeIframe(id, episodeId, url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        // Fetch the HTML using our internal method
        const htmlResult = await this.fetchIframeHtml(id, episodeId, url);
        
        // Import PlayModel to handle just the extraction part
        const PlayModel = require('../models/playModel');
        return PlayModel.extractSources(htmlResult, url);
    }

    async extractCloudflareSessionCookies(context) {
        try {
            const cookies = await context.cookies();
            const relevantCookies = cookies.filter(cookie => 
                cookie.name.includes('cf_clearance') || 
                cookie.name.includes('srvs') ||
                cookie.name.includes('__cf') ||
                cookie.name.includes('_cflb') ||
                cookie.domain.includes('kwik.si') ||
                cookie.domain.includes('.si')
            );

            if (relevantCookies.length > 0) {
                const cookieHeader = relevantCookies
                    .map(cookie => `${cookie.name}=${cookie.value}`)
                    .join('; ');
                
                console.log('Extracted Cloudflare session cookies:', 
                    relevantCookies.map(c => c.name).join(', '));
                
                this.cloudflareSessionCookies = {
                    header: cookieHeader,
                    cookies: relevantCookies,
                    timestamp: Date.now()
                };
                
                return cookieHeader;
            }
        } catch (error) {
            console.error('Failed to extract cookies:', error.message);
        }
        return null;
    }
 
    async scrapeIframeLight(url) {
        try {
            const html = await RequestManager.scrapeWithCloudScraper(url);
            
            if (html && html.length > 100 && 
                !html.toLowerCase().includes('just a moment') &&
                !html.toLowerCase().includes('checking your browser')) {
                return html;
            }
            
            throw new Error('Response blocked or invalid');
        } catch (error) {
            console.warn('Axios fallback failed:', error.message);
            throw error;
        }
    }
    
    async getData(type, params, preferFetch = true) {
        try {
            if (preferFetch) {
                switch (type) {
                    case 'airing':
                        return await this.fetchAiringData(params.page || 1);
                    case 'search':
                        return await this.fetchSearchData(params.query, params.page);
                    case 'queue':
                        return await this.fetchQueueData();
                    case 'releases':
                        return await this.fetchAnimeRelease(params.animeId, params.sort, params.page);
                }
            } else {
                switch (type) {
                    case 'animeList':
                        return await this.scrapeAnimeList(params.tag1, params.tag2);
                    case 'animeInfo':
                        return await this.scrapeAnimeInfo(params.animeId);
                    case 'play':
                        return await this.scrapePlayPage(params.id, params.episodeId);
                    case 'iframe':
                        return await this.scrapeIframe(params.id, params.episodeId, params.url);
                }
            }

            throw new CustomError(`Unsupported data type: ${type}`, 400);
        } catch (error) {
            if (error instanceof CustomError) throw error;

            // If we have an HTTP error response, use its status code
            if (error.response?.status) {
                throw new CustomError(error.message || 'Request failed', error.response.status);
            }

            // Try fallback if primary method fails
            if (preferFetch) {
                return this.getData(type, params, false);
            }
            
            throw new CustomError(error.message || 'Failed to get data', 503);
        }
    }
}

module.exports = new Animepahe();