const fs = require('fs').promises;
const path = require('path');
const Config = require('../utils/config');
const { JSDOM } = require('jsdom');
const vm = require('vm')
const RequestManager = require("../utils/requestManager");
const { launchBrowser } = require('../utils/browser');
const { CustomError } = require('../middleware/errorHandler');
const os = require('os');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Animepahe {
    constructor() {
        // Use /tmp directory for Vercel
        this.cookiesPath = path.join('/tmp', 'cookies.json');
        this.cookiesRefreshInterval = 14 * 24 * 60 * 60 * 1000; // 14 days
        this.isRefreshingCookies = false;
        this.activeBrowser = null;
        this.cloudflareSessionCookies = null

        // tracking for current kwik request
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

    async fetchIframeHtml(id, episodeId, url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        console.log('Initiating iframe HTML fetch:', url);

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

        const htmlResult = await this.fetchIframeHtml(id, episodeId, url);
        
        const PlayModel = require('../models/playModel');
        return PlayModel.extractSources(htmlResult, url);
    }

    async scrapeDownloadLinks(url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        const resolvedUrl = await this.extractKwikUrl(url);
        if (!resolvedUrl) {
            // If can't extract the URL, try the original URL
            const downloadUrl = await this.getKwikDownloadUrl(url);
            return { downloadUrl, type: 'direct_download' };
        }
        
        console.log('Found Kwik URL:', resolvedUrl);
        
        // Use the extracted URL for getting the download link
        const downloadUrl = await this.getKwikDownloadUrl(resolvedUrl);
        return { downloadUrl, type: 'redirected_download', originalUrl: url, resolvedUrl };
    }

    async extractKwikUrl(url) {
        try {
            console.log('[Step 1] Fetching page to extract Kwik URL:', url);
            
            const response = await RequestManager.cloudscraperGet(url, {
                headers: {
                    "Referer": "https://animepahe.si/",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                },
                timeout: 30000,
            });
    
            console.log("Page fetched for extraction, status:", response.statusCode);
            
            const body = response.body;
            
            const redirectPattern = /href\s*:\s*["']([^"']+)["']/i;
            const redirectMatch = body.match(redirectPattern);
            if (redirectMatch && redirectMatch[1] && redirectMatch[1].includes('kwik.cx')) {
                console.log('Found redirect URL:', redirectMatch[1]);
                return redirectMatch[1];
            }
            
            const scriptPattern = /href["']\s*,\s*["']([^"']+\.(?:kwik\.cx|kwikcx))[^"']*["']/i;
            const scriptMatch = body.match(scriptPattern);
            if (scriptMatch && scriptMatch[1]) {
                let kwikUrl = scriptMatch[1];
                if (kwikUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    kwikUrl = urlObj.protocol + '//' + urlObj.host + kwikUrl;
                } else if (!kwikUrl.startsWith('http')) {
                    kwikUrl = 'https://kwik.cx' + kwikUrl;
                }
                console.log('Found Kwik URL from script:', kwikUrl);
                return kwikUrl;
            }
            
            // Pattern 3: Look for kwik.cx URLs in href attributes
            const hrefPattern = /href\s*=\s*["']([^"']*\bkwik\.cx\b[^"']*)["']/gi;
            const hrefMatches = [...body.matchAll(hrefPattern)];
            if (hrefMatches.length > 0) {
                // Return the first kwik URL found
                let kwikUrl = hrefMatches[0][1];
                if (kwikUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    kwikUrl = urlObj.protocol + '//' + urlObj.host + kwikUrl;
                }
                console.log('Found Kwik URL from href:', kwikUrl);
                return kwikUrl;
            }
            
            // Pattern 4: Look for kwik.cx URLs in JavaScript redirects
            const jsRedirectPattern = /["'](https?:\/\/[^"'\s]*kwik\.cx[^"'\s]*)["']/i;
            const jsMatch = body.match(jsRedirectPattern);
            if (jsMatch && jsMatch[1]) {
                console.log('Found Kwik URL from JavaScript:', jsMatch[1]);
                return jsMatch[1];
            }
            
            // Pattern 5: Look for the specific script pattern you mentioned
            const specificPattern = /href"\s*,\s*"([^"]*kwik\.cx[^"]*)"/;
            const specificMatch = body.match(specificPattern);
            if (specificMatch && specificMatch[1]) {
                console.log('Found Kwik URL from specific pattern:', specificMatch[1]);
                return specificMatch[1];
            }
            
            console.log('No Kwik URL found in the HTML content');
            return null;
            
        } catch (error) {
            console.error('Error extracting Kwik URL:', error.message);
            return null;
        }
    }

    async getKwikDownloadUrl(url) {
        console.log("[Step 2] Fetching page for download link:", url);
    
        const getResponse = await RequestManager.cloudscraperGet(url, {
            headers: {
                "Referer": "https://animepahe.si/",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            },
            timeout: 30000,
        });
    
        console.log("Page fetched, status:", getResponse.statusCode);
        
        // Extract cookies
        const setCookieHeaders = getResponse.headers['set-cookie'] || [];
        const cookies = setCookieHeaders.map(cookie => cookie.split(';')[0]).join('; ');
        console.log("[Cookies]:", cookies);
    
        const body = getResponse.body;
        const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    
        let foundAction = null;
        let foundToken = null;
    
        // JavaScript execution environment
        const dom = new JSDOM(
            "<!doctype html><body><div class='adSense'></div><div class='adSense'></div></body>"
        );
        const { window } = dom;
        const { document } = window;
    
        const $ = (sel) => {
            if (typeof sel === "function") {
                try { sel.call(window); } catch (e) {}
                return $;
            }
            if (typeof sel !== "string")
                return {
                    html: () => "",
                    attr: () => "",
                    click: () => $,
                    on: () => $,
                    remove: () => $,
                    length: 0,
                };
    
            let els = [];
            const eqMatch = sel.match(/^(.+):eq\((\d+)\)$/);
            if (eqMatch) {
                const all = document.querySelectorAll(eqMatch[1]);
                els = all[parseInt(eqMatch[2])] ? [all[parseInt(eqMatch[2])]] : [];
            } else {
                try { els = Array.from(document.querySelectorAll(sel)); } catch (e) {}
            }
    
            const el = els[0];
            return {
                html: (v) => {
                    if (v !== undefined) {
                        const htmlStr = String(v);
                        const actionMatch = htmlStr.match(/action=["']([^"']+)["']/i);
                        if (actionMatch) foundAction = actionMatch[1];
                        const tokenMatch = htmlStr.match(/name=["']_token["'][^>]*value=["']([^"']+)["']/i);
                        if (tokenMatch) foundToken = tokenMatch[1];
                        if (el) el.innerHTML = htmlStr;
                        return this;
                    }
                    return el?.innerHTML || "";
                },
                attr: (n, v) => v !== undefined ? (el?.setAttribute(n, v), this) : el?.getAttribute(n) || "",
                click: (fn) => { if (typeof fn === "function") try { fn.call(el); } catch (e) {} return this; },
                on: () => this,
                remove: () => { el?.remove(); return this; },
                length: els.length,
            };
        };
        $.ajax = () => {};
    
        const sandbox = {
            window, document, console,
            navigator: { userAgent: "Mozilla/5.0" },
            MutationObserver: class { observe() {} },
            XMLHttpRequest: function () { this.open = this.send = this.setRequestHeader = () => {}; },
            fetch: async () => ({ ok: true, text: async () => "", json: async () => ({}) }),
            atob: (s) => Buffer.from(s, "base64").toString("binary"),
            btoa: (s) => Buffer.from(s, "binary").toString("base64"),
            $, setTimeout, clearTimeout,
        };
    
        for (const s of scripts) {
            if (s && s.length > 100) {
                try {
                    vm.runInContext(s, vm.createContext(sandbox), { timeout: 4000 });
                    if (foundAction && foundToken) break;
                } catch (e) {}
            }
        }
    
        if (!foundAction || !foundToken) {
            throw new Error("⌠ Could not extract form action or token");
        }
    
        console.log("[Step 3] Extracted action:", foundAction);
        console.log("[Step 3] Extracted token:", foundToken);
    
        // Wait a bit to simulate human behavior
        console.log("[Step 4] Waiting 2 seconds...");
        await sleep(2000);
    
        // Step 3: Submit POST request
        console.log("[Step 5] Submitting POST request...");
        
        const isServerless = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
        
        try {
            // Use unified RequestManager for POST - works on both serverless and local!
            const postResponse = await RequestManager.cloudscraperPost(
                foundAction,
                { _token: foundToken },
                {
                    json: false, // Use form encoding
                    headers: {
                        "Origin": "https://kwik.cx",
                        "Referer": url,
                        "Cookie": cookies,
                    },
                    followRedirect: false,
                    followAllRedirects: false,
                    timeout: 30000,
                }
            );

            console.log("[Step 6] Response status:", postResponse.statusCode);

            // Handle redirect responses
            if (postResponse.statusCode === 302 || postResponse.statusCode === 301) {
                const downloadUrl = postResponse.location || postResponse.headers.location;
                console.log("Final download URL:", downloadUrl);
                return downloadUrl;
            } 
            
            if (postResponse.statusCode === 200) {
                const body = postResponse.body;
                
                const metaMatch = body.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"]*url=([^"']+)["']/i);
                if (metaMatch) {
                    console.log("Found meta refresh URL:", metaMatch[1]);
                    return metaMatch[1];
                }
                
                const jsMatch = body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
                if (jsMatch) {
                    console.log("Found JavaScript redirect URL:", jsMatch[1]);
                    return jsMatch[1];
                }

                console.log("[Response body snippet]:", body.substring(0, 800));
            }
        } catch (error) {
            console.log("[Request Error]:", error.message);
            
            // Even errors might contain redirect info
            if (error.statusCode === 302 || error.statusCode === 301) {
                const downloadUrl = error.response?.headers?.location;
                if (downloadUrl) {
                    console.log("Final download URL (from error):", downloadUrl);
                    return downloadUrl;
                }
            }
            throw error;
        }
    
        throw new Error("✗ Could not extract download URL");
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
            console.warn('Cloudscraper method failed:', error.message);
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
                    case 'download':
                        return await this.scrapeDownloadLinks(params.url);
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