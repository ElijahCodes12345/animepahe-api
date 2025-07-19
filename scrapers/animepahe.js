const fs = require('fs').promises;
const path = require('path');
const Config = require('../utils/config');
const RequestManager = require("../utils/requestManager");
const { launchBrowser } = require('../utils/browser');
const { CustomError } = require('../middleware/errorHandler');
const os = require('os');

class Animepahe {
    constructor() {
        // Use /tmp directory for Vercel
        this.cookiesPath = path.join('/tmp', 'cookies.json');
        this.cookiesRefreshInterval = 14 * 24 * 60 * 60 * 1000; // 14 days
        this.isRefreshingCookies = false;
        this.activeBrowser = null;
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

    async scrapeIframe(url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        console.log('Fetching iframe URL:', url);

        // Try multiple strategies in order
        const strategies = [
            () => this.scrapeIframeWithPlaywright(url),
            () => this.scrapeIframeWithAxios(url),
            () => this.scrapeIframeWithRetry(url)
        ];

        let lastError = null;

        for (let i = 0; i < strategies.length; i++) {
            try {
                console.log(`Attempting strategy ${i + 1}/${strategies.length}`);
                const result = await strategies[i]();
                if (result && result.length > 100) {
                    console.log(`Strategy ${i + 1} succeeded`);
                    return result;
                }
            } catch (error) {
                console.warn(`Strategy ${i + 1} failed:`, error.message);
                lastError = error;
                
                // Wait before trying next strategy
                if (i < strategies.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        throw new CustomError(lastError?.message || 'All iframe fetching strategies failed', 503);
    }

    async scrapeIframeWithPlaywright(url, maxRetries = 2) {
        let browser = this.activeBrowser;
        let shouldCloseBrowser = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`Playwright attempt ${attempt}/${maxRetries} for: ${url}`);
            
            try {
                if (!browser) {
                    browser = await launchBrowser();
                    shouldCloseBrowser = true;
                    console.log('Browser launched for iframe scraping');
                }

                const context = await browser.newContext({
                    userAgent: Config.userAgent,
                    viewport: { width: 1920, height: 1080 },
                    ignoreHTTPSErrors: true,
                    bypassCSP: true,
                    javaScriptEnabled: true,
                    // Reduce memory usage
                    deviceScaleFactor: 1,
                    hasTouch: false,
                    ...(Config.proxyEnabled && Config.proxies.length > 0 && {
                        proxy: { server: Config.getRandomProxy() }
                    })
                });

                const page = await context.newPage();

                // Minimal stealth - reduce complexity for serverless
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                });

                // Optimized headers for serverless
                await page.setExtraHTTPHeaders({
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Referer': Config.getUrl('home')
                });

                console.log('Navigating to kwik URL...');
                
                // Shorter timeout for serverless
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                if (!response || response.status() >= 400) {
                    throw new Error(`HTTP ${response?.status() || 'unknown'} error`);
                }

                // Reduced wait times for serverless
                await page.waitForTimeout(3000);

                // Quick challenge detection
                const hasChallenge = await page.evaluate(() => {
                    const text = document.body.textContent.toLowerCase();
                    const title = document.title.toLowerCase();
                    
                    return text.includes('just a moment') ||
                        text.includes('checking your browser') ||
                        text.includes('ddos-guard') ||
                        title.includes('please wait') ||
                        document.querySelector('[id*="challenge"]') !== null;
                });

                if (hasChallenge) {
                    console.log('Challenge detected, waiting for resolution...');
                    
                    // Shorter timeout for serverless
                    try {
                        await page.waitForFunction(() => {
                            const text = document.body.textContent.toLowerCase();
                            const title = document.title.toLowerCase();
                            
                            return !text.includes('just a moment') &&
                                !text.includes('checking your browser') &&
                                !text.includes('ddos-guard') &&
                                !title.includes('please wait');
                        }, { timeout: 15000 });
                        
                        console.log('Challenge resolved');
                    } catch (timeoutError) {
                        console.log('Challenge timeout, checking content anyway...');
                    }
                }

                const html = await page.content();
                await context.close();

                // Validate content
                if (!html || html.length < 100) {
                    throw new Error('Empty or invalid response');
                }

                // Check if still blocked
                const finalContent = html.toLowerCase();
                if (finalContent.includes('access denied') ||
                    finalContent.includes('just a moment') ||
                    finalContent.includes('checking your browser')) {
                    throw new Error('Still blocked after challenge');
                }

                console.log('Playwright fetch successful');
                return html;

            } catch (error) {
                console.warn(`Playwright attempt ${attempt} failed:`, error.message);
                
                if (attempt === maxRetries) {
                    throw error;
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 3000));
            } finally {
                if (shouldCloseBrowser && browser) {
                    await browser.close().catch(e => console.error('Error closing browser:', e));
                    browser = null;
                }
            }
        }
    }

    async scrapeIframeWithAxios(url) {
        console.log('Trying Axios fallback for:', url);
        
        const headers = {
            'User-Agent': Config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Referer': Config.getUrl('home'),
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };

        try {
            // Step 1: Get initial cookies
            const firstResponse = await RequestManager.rawRequest(url, {
                headers,
                maxRedirects: 0,
                validateStatus: status => status < 400 || status === 302,
                timeout: 15000
            });

            let cookies = '';
            const setCookieHeader = firstResponse.headers['set-cookie'];
            if (setCookieHeader) {
                cookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
            }

            // Step 2: Make request with cookies
            const finalResponse = await RequestManager.rawRequest(url, {
                headers: {
                    ...headers,
                    ...(cookies && { 'Cookie': cookies })
                },
                timeout: 15000,
                validateStatus: status => status < 500
            });

            const html = finalResponse.data;
            
            if (html && html.length > 100 && 
                !html.toLowerCase().includes('just a moment') &&
                !html.toLowerCase().includes('checking your browser')) {
                console.log('Axios fallback successful');
                return html;
            }

            throw new Error('Axios response blocked or invalid');
            
        } catch (error) {
            console.warn('Axios fallback failed:', error.message);
            throw error;
        }
    }

    async scrapeIframeWithRetry(url, maxRetries = 1) {
        console.log('Final retry strategy for:', url);
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Simple delay-based retry with minimal browser
                const browser = await launchBrowser();
                
                try {
                    const context = await browser.newContext({
                        userAgent: Config.userAgent,
                        ignoreHTTPSErrors: true
                    });
                    
                    const page = await context.newPage();
                    
                    // Very minimal approach
                    await page.goto(url, { 
                        waitUntil: 'networkidle', 
                        timeout: 20000 
                    });
                    
                    // Longer wait in hope challenge completes
                    await page.waitForTimeout(8000);
                    
                    const html = await page.content();
                    await context.close();
                    
                    if (html && html.length > 100) {
                        console.log('Retry strategy successful');
                        return html;
                    }
                    
                    throw new Error('Invalid content from retry');
                    
                } finally {
                    await browser.close();
                }
                
            } catch (error) {
                console.warn(`Retry attempt ${attempt} failed:`, error.message);
                if (attempt === maxRetries) throw error;
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
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
                        return await this.scrapeIframe(params.url);
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