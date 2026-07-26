const fs = require('fs').promises;
const path = require('path');
const Config = require('../utils/config');
const { JSDOM } = require('jsdom');
const vm = require('vm')
const RequestManager = require("../utils/requestManager");
const BrowserService = require('../utils/browser');
const { CustomError } = require('../middleware/errorHandler');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Animepahe {
    constructor() {
        // cookiesPath is derived from Config.dataDir so consuming apps can
        // redirect storage outside of node_modules via:
        //   animepahe.Config.dataDir = '/your/persistent/path'
        this.isRefreshingCookies = false;
        this._refreshPromise = null; // shared promise lock — prevents concurrent browser launches
        this.activeBrowser = null;
        this.cloudflareSessionCookies = null

        // tracking for current kwik request
        this.currentKwikRequest = null;
    }

    get cookiesPath() {
        return require('path').join(Config.dataDir, 'cookies.json');
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
        // Deduplicate concurrent refresh calls — all callers share the same
        // promise so only ONE browser is ever launched at a time.
        if (this._refreshPromise) {
            console.log('[Animepahe] Cookie refresh already in progress, waiting...');
            return this._refreshPromise;
        }

        this.isRefreshingCookies = true;
        this._refreshPromise = (async () => {
            try {
                // BrowserService handles the full Cloudflare challenge-solve lifecycle.
                // render() navigates to the URL, solves Turnstile if present, and
                // returns the cookies once the challenge is cleared.
                const result = await BrowserService.render(Config.getUrl('home'), {
                    timeout: 120000,
                });

                const cookies = result.cookies;
                if (!cookies || cookies.length === 0) {
                    throw new CustomError('No cookies found after page load', 503);
                }

                const cookieData = {
                    timestamp: Date.now(),
                    // Save the UA that was active when cf_clearance was issued.
                    // Cloudflare binds cf_clearance to the exact User-Agent, so we
                    // must restore it on restart or gotScraping requests will be rejected.
                    userAgent: Config.userAgent,
                    cookies,
                };

                await fs.mkdir(Config.dataDir, { recursive: true });
                await fs.writeFile(this.cookiesPath, JSON.stringify(cookieData, null, 2));

                console.log('[Animepahe] ✅ Cookies refreshed');
            } catch (error) {
                console.error('[Animepahe] Cookie refresh error:', error.message);
                throw new CustomError(`Failed to refresh cookies: ${error.message}`, 503);
            } finally {
                this.isRefreshingCookies = false;
                this._refreshPromise = null;
            }
        })();

        return this._refreshPromise;
    }

    async getCookies(userProvidedCookies = null) {
        // If user provided cookies directly, use them
        if (userProvidedCookies) {
            if (typeof userProvidedCookies === 'string' && userProvidedCookies.trim()) {
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
            console.log('[Animepahe] No cookies.json found — refreshing...');
            await this.refreshCookies();
            cookieData = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
        }

        const ageInMs = Date.now() - cookieData.timestamp;
        const hasCfClearance = Array.isArray(cookieData.cookies) &&
            cookieData.cookies.some(c => c.name === 'cf_clearance');

        // Force a blocking refresh if:
        //   (a) cookies are older than the refresh interval, OR
        //   (b) cf_clearance is missing entirely (browser challenge was never solved)
        if ((ageInMs > this.cookiesRefreshInterval || !hasCfClearance) && !this.isRefreshingCookies) {
            console.log(`[Animepahe] Cookies need refresh (age: ${Math.round(ageInMs / 86400000)}d, hasCfClearance: ${hasCfClearance}). Refreshing now...`);
            await this.refreshCookies();
            cookieData = JSON.parse(await fs.readFile(this.cookiesPath, 'utf8'));
        } else if (ageInMs > (this.cookiesRefreshInterval - 24 * 60 * 60 * 1000) && !this.isRefreshingCookies) {
            // Proactive background refresh if cookies are within 1 day of expiring
            this.isRefreshingCookies = true;
            this.refreshCookies()
                .catch(err => console.error('Background cookie refresh failed:', err))
                .finally(() => { this.isRefreshingCookies = false; });
        }

        // Restore the User-Agent that was active when cf_clearance was issued.
        // Without this, Config.userAgent stays at its default (Chrome/120) after a
        // server restart, causing gotScraping requests to be rejected by Cloudflare
        // even though the cookies themselves are still valid.
        if (cookieData.userAgent) {
            Config.userAgent = cookieData.userAgent;
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
            // Retry once with fresh cookies if:
            //   - user didn't supply cookies, AND
            //   - the error is an auth failure (401/403) OR an anti-bot challenge (503)
            const isChallenge = !userProvidedCookies && (
                error.statusCode === 401 ||
                error.statusCode === 403 ||
                error.statusCode === 503 ||
                error.response?.status === 401 ||
                error.response?.status === 403 ||
                (error.message && error.message.includes('Anti-bot challenge'))
            );

            if (isChallenge && !this._retryingFetch) {
                console.warn('[Animepahe] Anti-bot / auth error detected — refreshing cookies and retrying...');
                this._retryingFetch = true;
                try {
                    await this.refreshCookies();
                    return await this.fetchApiData(endpoint, params, userProvidedCookies);
                } finally {
                    this._retryingFetch = false;
                }
            }

            throw new CustomError(error.message || 'Failed to fetch API data', error.statusCode || error.response?.status || 503);
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
        let cookieHeader = await this.getCookies();

        try {
            const html = await RequestManager.fetch(url, cookieHeader);
            if (!html) throw new CustomError('Failed to fetch anime info', 503);
            return html;
        } catch (error) {
            // If we got a CF challenge, refresh cookies and retry once
            const isChallenge = error.message && error.message.includes('Anti-bot challenge');
            if (isChallenge && !this._retryingScrape) {
                console.warn('[Animepahe] Anti-bot challenge on anime info page — refreshing cookies and retrying...');
                this._retryingScrape = true;
                try {
                    await this.refreshCookies();
                    cookieHeader = await this.getCookies();
                    const html = await RequestManager.fetch(url, cookieHeader);
                    if (!html) throw new CustomError('Failed to fetch anime info after cookie refresh', 503);
                    return html;
                } finally {
                    this._retryingScrape = false;
                }
            }
            throw error;
        }
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

            if (!html) {
                throw new CustomError('Failed to fetch play page', 503);
            }
            return html;
        } catch (error) {
            if (
                error.response?.status === 403 ||
                (error.message && error.message.includes('Anti-bot challenge'))
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
            () => this.scrapeIframePlaywright(url),
        ];

        const errors = [];

        for (let i = 0; i < allStrategies.length; i++) {
            const strategy = allStrategies[i];
            try {
                console.log(`Trying strategy ${i + 1}/${allStrategies.length}...`);
                const result = await strategy();
                
                if (result && result.length > 100) {
                    console.log(`Strategy ${i + 1} succeeded`);
                    return result;
                }
                
                throw new Error('Result too short or invalid');
            } catch (error) {
                console.warn(`Strategy ${i + 1} failed:`, error.message);
                errors.push(`Strategy ${i + 1}: ${error.message}`);
            }
        }

        // If all strategies failed, throw error with all failure details
        throw new CustomError(`All iframe fetching strategies failed: ${errors.join(', ')}`, 503);
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

        const { kwikUrl: resolvedUrl, filename } = await this.extractKwikUrl(url);
        if (!resolvedUrl) {
            // If can't extract the URL, try the original URL
            const { downloadUrl, filename: directFilename } = await this.getKwikDownloadUrl(url);
            return { downloadUrl, filename: directFilename, type: 'direct_download' };
        }
        
        console.log('Found Kwik URL:', resolvedUrl);
        if (filename) console.log('Extracted Certain Filename:', filename);
        
        // Use the extracted URL for getting the download link
        const { downloadUrl, filename: kwikFilename } = await this.getKwikDownloadUrl(resolvedUrl);
        return { 
            downloadUrl, 
            filename: filename || kwikFilename, 
            type: 'redirected_download', 
            originalUrl: url, 
            resolvedUrl 
        };
    }

    async extractKwikUrl(url) {
        try {
            console.log('[Step 1] Fetching page to extract Kwik URL:', url);
            
            const response = await RequestManager.cloudscraperGet(url, {
                headers: {
                    "Referer": Config.getUrl('home'),
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                },
                timeout: 30000,
            });
    
            console.log("Page fetched for extraction, status:", response.statusCode);
            
            const body = response.body;

            let filename = null;
            // The title may or may not contain ":: Kwik"
            const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch && titleMatch[1]) {
                filename = titleMatch[1].replace(/\s*::\s*Kwik.*$/i, '').trim();
            } else {
                const h2Match = body.match(/<h2>\s*([^<]+)\s*<\/h2>/i);
                if (h2Match && h2Match[1]) {
                    filename = h2Match[1].replace(/\s*::\s*Kwik.*$/i, '').trim();
                }
            }
            
            const redirectPattern = /href\s*:\s*["']([^"']+)["']/i;
            const redirectMatch = body.match(redirectPattern);
            if (redirectMatch && redirectMatch[1] && redirectMatch[1].includes(Config.iframeBaseUrl)) {
                console.log('Found redirect URL:', redirectMatch[1]);
                return { kwikUrl: redirectMatch[1], filename };
            }
            
            // Dynamic regex for script pattern
            // Original: /href["']\s*,\s*["']([^"']+\.(?:kwik\.cx|kwikcx))[^"']*["']/i
            const inputDomain = Config.iframeBaseUrl.replace('.', '\\.'); // escape dot
            const scriptPattern = new RegExp(`href["']\\s*,\\s*["']([^"']+\\.(?:${inputDomain}|${inputDomain.replace('\\.', '')}))[^"']*["']`, 'i');
            const scriptMatch = body.match(scriptPattern);
            if (scriptMatch && scriptMatch[1]) {
                let kwikUrl = scriptMatch[1];
                if (kwikUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    kwikUrl = urlObj.protocol + '//' + urlObj.host + kwikUrl;
                } else if (!kwikUrl.startsWith('http')) {
                    kwikUrl = `https://${Config.iframeBaseUrl}${kwikUrl}`;
                }
                console.log('Found Kwik URL from script:', kwikUrl);
                return { kwikUrl, filename };
            }
            
            // Pattern 3: Look for kwik.cx URLs in href attributes
            // inputDomain already defined above
            const hrefPattern = new RegExp(`href\\s*=\\s*["']([^"']*\\b${inputDomain}\\b[^"']*)["']`, 'gi');
            const hrefMatches = [...body.matchAll(hrefPattern)];
            if (hrefMatches.length > 0) {
                // Return the first kwik URL found
                let kwikUrl = hrefMatches[0][1];
                if (kwikUrl.startsWith('/')) {
                    const urlObj = new URL(url);
                    kwikUrl = urlObj.protocol + '//' + urlObj.host + kwikUrl;
                }
                console.log('Found Kwik URL from href:', kwikUrl);
                return { kwikUrl, filename };
            }
            
            // Pattern 4: Look for kwik.cx URLs in JavaScript redirects
            const jsRedirectPattern = new RegExp(`["'](https?:\\/\\/[^"']*${inputDomain}[^"']*)["']`, 'i');
            const jsMatch = body.match(jsRedirectPattern);
            if (jsMatch && jsMatch[1]) {
                console.log('Found Kwik URL from JavaScript:', jsMatch[1]);
                return { kwikUrl: jsMatch[1], filename };
            }
            
            // Pattern 5: Look for the specific script pattern you mentioned
            const specificPattern = new RegExp(`href"\\s*,\\s*"([^"]*${inputDomain}[^"]*)"`);
            const specificMatch = body.match(specificPattern);
            if (specificMatch && specificMatch[1]) {
                console.log('Found Kwik URL from specific pattern:', specificMatch[1]);
                return { kwikUrl: specificMatch[1], filename };
            }
            
            console.log('No Kwik URL found in the HTML content');
            return { kwikUrl: null, filename };
            
        } catch (error) {
            console.error('Error extracting Kwik URL:', error.message);
            return { kwikUrl: null, filename: null };
        }
    }

    async getKwikDownloadUrl(url) {
        console.log("[Step 2] Fetching page for download link:", url);
    
        const getResponse = await RequestManager.cloudscraperGet(url, {
            headers: {
                "Referer": Config.getUrl('home'),
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

        // Extract filename from the kwik page itself as fallback/verification
        let filename = null;
        const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            filename = titleMatch[1].replace(/\s*::\s*Kwik.*$/i, '').trim();
        }
    
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
                        "Origin": `https://${Config.iframeBaseUrl}`,
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
                return { downloadUrl, filename };
            } 
            
            if (postResponse.statusCode === 200) {
                const body = postResponse.body;
                
                const metaMatch = body.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"]*url=([^"']+)["']/i);
                if (metaMatch) {
                    console.log("Found meta refresh URL:", metaMatch[1]);
                    return { downloadUrl: metaMatch[1], filename };
                }
                
                const jsMatch = body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
                if (jsMatch) {
                    console.log("Found JavaScript redirect URL:", jsMatch[1]);
                    return { downloadUrl: jsMatch[1], filename };
                }
            }
        } catch (error) {
            console.log("[Request Error]:", error.message);
            
            // Even errors might contain redirect info
            if (error.statusCode === 302 || error.statusCode === 301) {
                const downloadUrl = error.response?.headers?.location;
                if (downloadUrl) {
                    console.log("Final download URL (from error):", downloadUrl);
                    return { downloadUrl, filename };
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
            const html = await RequestManager.scrapeWithGotScraping(url, {
                referer: Config.getUrl("home")
            });
            
            if (html && html.toLowerCase().includes('attention required!')) {
                throw new Error('Response blocked or invalid');
            }

            if (html && html.length > 100 && 
                !html.toLowerCase().includes('just a moment') &&
                !html.toLowerCase().includes('checking your browser')) {
                return html;
            }
            
            throw new Error('Response blocked or invalid');
        } catch (error) {
            console.warn('[scrapeIframeLight] GotScraping failed:', error.message);
            throw error;
        }
    }

    async scrapeIframePlaywright(url) {
        try {
            const html = await RequestManager.scrapeWithPlaywrightPage(url, {
                referer: Config.getUrl("home")
            });

            if (html && html.toLowerCase().includes('attention required!')) {
                throw new Error('Response blocked or invalid');
            }

            if (html && html.length > 100 &&
                !html.toLowerCase().includes('just a moment') &&
                !html.toLowerCase().includes('checking your browser')) {
                return html;
            }

            throw new Error('Response blocked or invalid');
        } catch (error) {
            console.warn('[scrapeIframePlaywright] Playwright failed:', error.message);
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