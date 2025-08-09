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

    async scrapeIframe(id, episodeId, url) {
        if (!url) {
            throw new CustomError('URL is required', 400);
        }

        console.log('Fetching iframe URL:', url);
        const playPageUrl = Config.getUrl('play', id, episodeId);

        const strategies = [
            () => this.scrapeIframeWithAxios(url),
            () => this.scrapeIframeWithPlaywright(playPageUrl, url),
            () => this.scrapeIframeWithRetry(url)
        ];

        let lastError = null;

        for (let i = 0; i < strategies.length; i++) {
            try {
                console.log(`Attempting strategy ${i + 1}/${strategies.length}`);
                const htmlResult = await strategies[i]();
                if (htmlResult && htmlResult.length > 100) {
                    console.log(`Strategy ${i + 1} succeeded`);
                    
                    const sources = this.extractSourcesFromIframeHtml(htmlResult);
                    return sources;
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

    // NEW: Extract sources from iframe HTML (moved from PlayModel)
    extractSourcesFromIframeHtml(iframeHtml) {
        const execResult = /(eval)(\(f.*?)(\n<\/script>)/s.exec(iframeHtml);
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
                
                console.log('🍪 Extracted Cloudflare session cookies:', 
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

    async scrapeIframeWithExtractedCookies(url) {
        if (!this.cloudflareSessionCookies) {
            throw new Error('No Cloudflare session cookies available');
        }

        // check if cookies are still fresh (default 30 minutes)
        const cookieAge = Date.now() - this.cloudflareSessionCookies.timestamp;
        if (cookieAge > 30 * 60 * 1000) {
            console.log('⚠️ Cookies are older than 30 minutes, may need refresh');
            this.cloudflareSessionCookies = null;
            throw new Error('Cookies too old');
        }

        console.log('🚀 Using extracted cookies for fast Axios request:', url);
        
        const headers = {
            'User-Agent': Config.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Referer': Config.getUrl('home'),
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cookie': this.cloudflareSessionCookies.header,
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"'
        };

        try {
            const response = await RequestManager.rawRequest(url, {
                headers,
                timeout: 15000,
                validateStatus: status => status < 500
            });

            const html = response.data;

            console.log(`${url}: ${html}`);
            
            if (html && html.length > 100 && 
                !html.toLowerCase().includes('just a moment') &&
                !html.toLowerCase().includes('checking your browser') &&
                !html.toLowerCase().includes('challenge')) {
                console.log('✅ Fast cookie request successful for:', url);
                
                // Process HTML and return sources array
                return this.extractSourcesFromIframeHtml(html);
            }

            throw new Error('Response appears to be blocked or invalid');
            
        } catch (error) {
            console.warn('❌ Fast cookie request failed:', error.message);
            throw error;
        }
    }

    async scrapeIframeWithPlaywright(animepaheUrl, targetKwikUrl = null, maxRetries = 2) {
        console.log('Trying enhanced Playwright method for:', animepaheUrl);
        if (targetKwikUrl) {
            console.log('Target kwik URL:', targetKwikUrl);
        }
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let browser = null;
            try {
                browser = await launchBrowser();
                const context = await browser.newContext({
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    viewport: { width: 1280, height: 800 },
                    javaScriptEnabled: true,
                    extraHTTPHeaders: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
                    }
                });

                const page = await context.newPage();

                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    Object.defineProperty(navigator, 'plugins', { 
                        get: () => [
                            { name: 'Chrome PDF Plugin' },
                            { name: 'Chrome PDF Viewer' },
                            { name: 'Native Client' }
                        ] 
                    });
                    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                    window.chrome = { runtime: {} };
                    const originalQuery = window.navigator.permissions.query;
                    window.navigator.permissions.query = (parameters) => (
                        parameters.name === 'notifications' ?
                            Promise.resolve({ state: Notification.permission }) :
                            originalQuery(parameters)
                    );
                    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
                    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
                    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
                    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
                });

                await page.route('**/*', (route) => {
                    const url = route.request().url();
                    if (/ads|doubleclick|popunder|popads|brunetsmolted|duelistdoesnt|kryptonnutlet|whitebit|garsilgilpey|analytics|googletagmanager|facebook|twitter/.test(url)) {
                        return route.abort();
                    }
                    route.continue();
                });

                console.log(`Attempt ${attempt}: Navigating to Animepahe...`);
                await page.goto(animepaheUrl, { waitUntil: 'networkidle', timeout: 60000 });
                
                await page.waitForTimeout(3000);

                let kwikResponse = null;
                let kwikUrl = null;
                let cookiesExtracted = false;

                await page.route('**/kwik.si/e/**', async (route) => {
                    const url = route.request().url();
                    const urlId = url.split('kwik.si/e/')[1]?.split('?')[0];
                    
                    // If we have a specific target, only intercept that URL
                    if (targetKwikUrl) {
                        const targetId = targetKwikUrl.split('kwik.si/e/')[1]?.split('?')[0];
                        if (urlId !== targetId) {
                            console.log(`Skipping non-target kwik URL: ${urlId} (target: ${targetId})`);
                            return route.continue();
                        }
                    }
                    
                    console.log('🎯 Intercepting kwik route:', url);
                    kwikUrl = url;
                    
                    try {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        const response = await route.fetch({
                            headers: {
                                ...route.request().headers(),
                                'Referer': animepaheUrl,
                                'Origin': 'https://animepahe.ru',
                                'Sec-Fetch-Dest': 'iframe',
                                'Sec-Fetch-Mode': 'navigate',
                                'Sec-Fetch-Site': 'cross-site',
                                'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                                'Sec-Ch-Ua-Mobile': '?0',
                                'Sec-Ch-Ua-Platform': '"Windows"',
                            }
                        });

                        const responseText = await response.text();
                        
                        if (responseText.includes('Just a moment') || responseText.includes('challenge')) {
                            console.log('⚠️ Received Cloudflare challenge, waiting for bypass...');
                            await route.continue();
                            
                            setTimeout(async () => {
                                try {
                                    const delayedResponse = await page.evaluate(async (url) => {
                                        const response = await fetch(url, {
                                            headers: {
                                                'User-Agent': navigator.userAgent,
                                                'Referer': window.location.href,
                                                'Accept': '*/*',
                                                'Accept-Language': 'en-US,en;q=0.9',
                                                'Cache-Control': 'no-cache'
                                            }
                                        });
                                        return await response.text();
                                    }, url);
                                    
                                    if (delayedResponse && !delayedResponse.includes('Just a moment')) {
                                        kwikResponse = delayedResponse;
                                        console.log('✅ Successfully bypassed Cloudflare via delayed fetch');
                                        
                                        if (!cookiesExtracted) {
                                            await this.extractCloudflareSessionCookies(context);
                                            cookiesExtracted = true;
                                        }
                                    }
                                } catch (err) {
                                    console.error('Delayed fetch failed:', err.message);
                                }
                            }, 5000);
                            
                        } else {
                            kwikResponse = responseText;
                            console.log('✅ Captured kwik response via route interception');
                            
                            if (!cookiesExtracted) {
                                await this.extractCloudflareSessionCookies(context);
                                cookiesExtracted = true;
                            }
                            
                            await route.fulfill({
                                response: response
                            });
                        }
                        
                    } catch (err) {
                        console.error('Route interception failed:', err.message);
                        route.continue();
                    }
                });

                if (targetKwikUrl) {
                    console.log('Navigating directly to target kwik URL in iframe...');
                    await page.evaluate((url) => {
                        const iframe = document.createElement('iframe');
                        iframe.src = url;
                        iframe.style.display = 'none';
                        document.body.appendChild(iframe);
                    }, targetKwikUrl);
                } else {
                    // Original behavior: click the load button
                    await page.waitForSelector('.click-to-load .reload', { timeout: 45000 });
                    await page.click('.click-to-load .reload');
                    console.log('✅ Clicked load button, waiting for kwik response...');
                }

                // Wait for response
                const maxWait = 60000; 
                const interval = 2000;
                let elapsed = 0;

                while (!kwikResponse && elapsed < maxWait) {
                    await page.waitForTimeout(interval);
                    elapsed += interval;
                    console.log(`Waiting for kwik response... ${elapsed / 1000}s`);
                    
                    if (elapsed === 20000 && kwikUrl && !kwikResponse) {
                        console.log('🔄 Trying direct iframe navigation...');
                        try {
                            const kwikPage = await context.newPage();
                            await kwikPage.goto(kwikUrl, { waitUntil: 'networkidle', timeout: 30000 });
                            await kwikPage.waitForTimeout(10000);
                            
                            const content = await kwikPage.content();
                            if (!content.includes('Just a moment')) {
                                kwikResponse = content;
                                console.log('✅ Successfully got content via direct navigation');
                                
                                if (!cookiesExtracted) {
                                    await this.extractCloudflareSessionCookies(context);
                                    cookiesExtracted = true;
                                }
                            }
                            
                            await kwikPage.close();
                        } catch (err) {
                            console.error('Direct navigation failed:', err.message);
                        }
                    }
                }

                await context.close();

                if (!kwikResponse) {
                    throw new Error(`kwik response not captured within time limit. URL detected: ${kwikUrl || 'none'}`);
                }

                if (kwikResponse.includes('Just a moment') || kwikResponse.includes('Checking your browser')) {
                    throw new Error('Cloudflare challenge still active after bypass attempts');
                }

                console.log(`✅ Playwright method successful on attempt ${attempt}`);
                console.log('🍪 Cookies extraction status:', cookiesExtracted ? 'SUCCESS' : 'FAILED');
                
                return kwikResponse;

            } catch (error) {
                console.warn(`Playwright attempt ${attempt} failed:`, error.message);
                if (attempt === maxRetries) {
                    throw new Error(`All Playwright attempts failed. Last error: ${error.message}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            } finally {
                if (browser) {
                    await browser.close();
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