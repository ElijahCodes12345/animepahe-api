const BrowserService = require('./browser');
const axios = require('axios');
const Config = require('./config');
const { CustomError } = require('../middleware/errorHandler');


class RequestManager {
    static getPlaywrightProxyOptions(proxyString) {
        if (!proxyString) return null;
        try {
            const formatted = (proxyString.startsWith('http://') || proxyString.startsWith('https://') || proxyString.startsWith('socks5://'))
                ? proxyString 
                : 'http://' + proxyString;
            const parsedUrl = new URL(formatted);
            const proxyOptions = {
                server: `${parsedUrl.protocol}//${parsedUrl.host}`
            };
            if (parsedUrl.username) {
                proxyOptions.username = decodeURIComponent(parsedUrl.username);
            }
            if (parsedUrl.password) {
                proxyOptions.password = decodeURIComponent(parsedUrl.password);
            }
            return proxyOptions;
        } catch (e) {
            console.error('Error parsing proxy for Playwright:', e.message);
            return { server: proxyString };
        }
    }

    static maskProxyUrl(proxyUrl) {
        if (!proxyUrl) return 'null';
        try {
            const formatted = (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://') || proxyUrl.startsWith('socks5://'))
                ? proxyUrl 
                : 'http://' + proxyUrl;
            const parsed = new URL(formatted);
            let maskedUser = '';
            let maskedPass = '';
            if (parsed.username) {
                maskedUser = parsed.username.substring(0, Math.min(2, parsed.username.length)) + '*'.repeat(Math.max(0, parsed.username.length - 2));
            }
            if (parsed.password) {
                maskedPass = parsed.password.substring(0, Math.min(2, parsed.password.length)) + '*'.repeat(Math.max(0, parsed.password.length - 2));
            }
            const auth = parsed.username ? `${maskedUser}:${maskedPass}@` : '';
            return `${parsed.protocol}//${auth}${parsed.host} (length: ${proxyUrl.length}, raw length: ${proxyUrl.trim().length})`;
        } catch (e) {
            return `[Invalid/Unparseable Proxy URL] (length: ${proxyUrl.length})`;
        }
    }

    /**
     * Universal cloudscraper method - handles GET, POST, and any HTTP method
     * @param {Object} options - Request options
     * @param {string} options.method - HTTP method (GET, POST, etc.)
     * @param {string} options.url - Target URL
     * @param {Object} options.headers - Custom headers
     * @param {Object} options.form - Form data (for POST)
     * @param {Object} options.json - JSON body (for POST)
     * @param {boolean} options.followRedirect - Follow redirects (default: true)
     * @param {number} options.timeout - Request timeout in ms
     * @param {string} options.referer - Referer header
     * @returns {Promise<Object>} Response with { statusCode, headers, body }
     */
    static async cloudscraperRequest(options = {}) {
        const {
            method = 'GET',
            url,
            headers = {},
            form = null,
            json = null,
            followRedirect = true,
            followAllRedirects = false,
            timeout = 30000,
            referer = Config.getUrl('home'),
            resolveWithFullResponse = true,
            simple = false
        } = options;

        if (!url) {
            throw new CustomError('URL is required for request', 400);
        }

        const defaultHeaders = {
            'User-Agent': Config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': referer,
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
        };

        try {
            console.log(`[GotScraping Wrapper] ${method} ${url}`);
            const { gotScraping } = await import('got-scraping');
            
            const gotOptions = {
                url,
                method,
                headers: { ...defaultHeaders, ...headers },
                followRedirect,
                throwHttpErrors: false,
                timeout: { request: timeout }
            };

            if (form) {
                gotOptions.form = form;
            } else if (json) {
                gotOptions.json = json;
            }

            const response = await gotScraping(gotOptions);
            
            return {
                statusCode: response.statusCode,
                headers: response.headers,
                body: response.body,
                location: response.headers.location
            };
        } catch (error) {
            console.error(`[GotScraping Wrapper Error] ${method} ${url}:`, error.message);
            throw error;
        }
    }

    /**
     * Simplified GET request with cloudscraper
     */
    static async cloudscraperGet(url, options = {}) {
        return this.cloudscraperRequest({
            method: 'GET',
            url,
            ...options
        });
    }

    /**
     * Simplified POST request with cloudscraper
     */
    static async cloudscraperPost(url, data = {}, options = {}) {
        const isJson = options.json !== false;
        
        return this.cloudscraperRequest({
            method: 'POST',
            url,
            ...(isJson ? { json: data } : { form: data }),
            ...options
        });
    }

    static async fetch(url, cookieHeader, type = 'default') {
        if (type === 'default') {
            // HTML page scrape — use gotScraping with the supplied cookies.
            // fetchApiData is JSON-only and rejects HTML responses as CF challenges.
            // Must pass the same User-Agent that was used when cf_clearance was issued.
            return this.scrapeWithGotScraping(url, {
                userAgent: Config.userAgent,
                headers: {
                    'Cookie': cookieHeader || '',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'sec-fetch-dest': 'document',
                    'sec-fetch-mode': 'navigate',
                    'sec-fetch-site': 'same-origin',
                }
            });
        } else if (type === 'heavy') {
            return this.scrapeWithPlaywright(url);
        } else {
            console.trace('Invalid fetch type specified. Please use "heavy", or "default".');
            return null;
        }
    }

    /**
     * Scrape using got-scraping to bypass simple bot protection.
     * Pass options.userAgent to pin the User-Agent (required when using cf_clearance
     * cookies, since Cloudflare ties the token to the exact UA that solved the challenge).
     */
    static async scrapeWithGotScraping(url, options = {}) {
        console.log(`Fetching HTML with GotScraping from ${url}...`);
        
        const { gotScraping } = await import('got-scraping');
        
        // Use the explicitly supplied UA, or fall back to Config.userAgent, then
        // let got-scraping auto-generate one as a last resort.
        const userAgent = options.userAgent || Config.userAgent || undefined;

        try {
            const response = await gotScraping({
                url: url,
                headers: {
                    'Referer': options.referer || Config.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Connection': 'keep-alive',
                    ...(userAgent ? { 'User-Agent': userAgent } : {}),
                    ...options.headers
                },
                headerGeneratorOptions: {
                    browsers: [{name: 'chrome', minVersion: 110}],
                    devices: ['desktop'],
                    locales: ['en-US', 'en'],
                    operatingSystems: ['windows']
                },
                throwHttpErrors: false,
                timeout: { request: options.timeout || 30000 }
            });

            const body = response.body || '';

            // Check for definitive HTTP errors before CF challenge detection.
            // This prevents a 404 (wrong/non-existent page) from being misdiagnosed as a Cloudflare challenge when cookies are also stale.
            if (response.statusCode === 404) {
                throw new CustomError('Page not found (404) — check that the anime ID is correct', 404);
            }

            // Detect Cloudflare challenge in HTML scrape responses too
            if (body.includes('Just a moment') ||
                body.includes('challenge-running') ||
                body.includes('cf-please-wait')) {
                throw new Error('Anti-bot challenge active — cookies may be stale (Status Code: 503)');
            }

            // A 403 after a server restart almost always means CF is presenting a
            // fresh challenge (the old cf_clearance was tied to the previous browser
            // session). Treat it as a retryable challenge so callers can refresh
            // cookies + retry, rather than surfacing a hard 403 to the end user.
            if (response.statusCode === 403) {
                throw new Error('Anti-bot challenge active — cookies may be stale (Status Code: 403)');
            }

            return body;
        } catch (error) {
            console.error(`[GotScraping Error] GET ${url}:`, error.message);
            throw error;
        }
    }

    /**
     * Scrape a page using BrowserService (patchright), which automatically
     * solves Cloudflare Turnstile / managed challenges via a persistent context.
     */
    static async scrapeWithPlaywrightPage(url, options = {}) {
        console.log(`Fetching HTML with BrowserService (patchright) from ${url}...`);
        const result = await BrowserService.render(url, { timeout: options.timeout });
        return result.content;
    }

    /**
     * @deprecated Use scrapeWithPlaywrightPage instead.
     * Kept for backward compatibility with routes/scrapers that call this directly.
     */
    static async scrapeWithPlaywright(url) {
        return this.scrapeWithPlaywrightPage(url);
    }

    static async fetchJson(url) {
        const html = await this.fetch(url);
        
        try {
            const jsonMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || 
                             html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
            
            if (jsonMatch) {
                try {
                    return JSON.parse(jsonMatch[1].trim());
                } catch (e) {
                    console.log('Failed to parse JSON from matched content, trying whole page');
                    return JSON.parse(html);
                }
            } else {
                return JSON.parse(html);
            }
        } catch (error) {
            console.error('Failed to parse JSON:', error.message);
            throw new Error(`Failed to parse JSON from ${url}: ${error.message}`);
        }
    }      
    
    static async rawRequest(url, options = {}) {
        try {
            return await axios.get(url, options);
        } catch (err) {
            throw err;
        }
    }

    /**
     * Fetch a Cloudflare-protected page using BrowserService (patchright).
     */
    static async fetchCloudflareProtected(url, options = {}) {
        console.log('Fetching Cloudflare-protected content from:', url);
        const result = await BrowserService.render(url, { timeout: options.timeout });
        return result.content;
    }

    /**
     * Fetch JSON API data using got-scraping (fast HTTP, not a browser page).
     * BrowserService is used only to prime the cf_clearance cookie the first
     * time — subsequent calls reuse the same cookie for speed.
     */
    static async fetchApiData(url, params = {}, cookieHeader = null) {
        // 1. Build full URL with query params
        const queryString = new URLSearchParams(params).toString();
        const fullUrl = queryString ? `${url}?${queryString}` : url;

        // 2. If no cookie supplied, prime cf_clearance via BrowserService
        if (!cookieHeader) {
            const origin = new URL(url).origin;
            const result = await BrowserService.render(origin, { timeout: 120000 });
            cookieHeader = result.cookies
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
        }

        // 3. Lightweight got-scraping request with the CF cookies
        const { gotScraping } = await import('got-scraping');
        const response = await gotScraping({
            url: fullUrl,
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': Config.getUrl('home'),
                'User-Agent': Config.userAgent,
                'dnt': '1',
                'sec-ch-ua': '"Not A(Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'x-requested-with': 'XMLHttpRequest',
                'Cookie': cookieHeader,
            },
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 124 }],
                devices: ['desktop'],
                locales: ['en-US'],
                operatingSystems: ['windows'],
            },
            throwHttpErrors: false,
            timeout: { request: 30000 },
        });

        // 4. Challenge / error detection
        //    Only reject on actual Cloudflare/bot-protection signals.
        //    Do NOT use `isHtml` as a blanket trigger — JSON API responses are
        //    expected here, but a valid HTML body is NOT a challenge by itself.
        const body = response.body.trimStart();
        const isCfChallenge =
            response.statusCode === 403 ||
            response.statusCode === 503 ||
            body.includes('Just a moment') ||
            body.includes('challenge-running') ||
            body.includes('cf-please-wait') ||
            body.includes('cf_chl_rt_tk') ||
            body.includes('cf_chl_f_tk');

        if (isCfChallenge) {
            throw new CustomError('Anti-bot challenge active — cookies may be stale', 503);
        }

        if (response.statusCode === 404) throw new CustomError('Resource not found', 404);
        if (response.statusCode >= 500) throw new CustomError(`Upstream error (${response.statusCode})`, 503);

        try {
            return JSON.parse(body);
        } catch {
            throw new CustomError('Failed to parse API response as JSON', 503);
        }
    }
}

module.exports = RequestManager;