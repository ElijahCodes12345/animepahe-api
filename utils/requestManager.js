const { launchBrowser } = require('./browser');
const cloudscraper = require('cloudscraper');
const axios = require('axios');
const Config = require('./config');
const { CustomError } = require('../middleware/errorHandler');

class RequestManager {
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
            throw new CustomError('URL is required for cloudscraper request', 400);
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

        const requestOptions = {
            method,
            uri: url,
            headers: { ...defaultHeaders, ...headers },
            followRedirect,
            followAllRedirects,
            simple,
            resolveWithFullResponse,
            timeout,
        };

        // Add body data if provided
        if (form) {
            requestOptions.form = form;
            requestOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else if (json) {
            requestOptions.json = json;
            requestOptions.headers['Content-Type'] = 'application/json';
        }

        try {
            console.log(`[Cloudscraper] ${method} ${url}`);
            const response = await cloudscraper(requestOptions);
            
            return {
                statusCode: response.statusCode,
                headers: response.headers,
                body: response.body
            };
        } catch (error) {
            // Handle redirects as responses (not errors)
            if (error.statusCode === 301 || error.statusCode === 302) {
                return {
                    statusCode: error.statusCode,
                    headers: error.response?.headers || {},
                    body: error.response?.body || '',
                    location: error.response?.headers?.location
                };
            }
            
            console.error(`[Cloudscraper Error] ${method} ${url}:`, error.message);
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
            return this.fetchApiData(url, {}, cookieHeader);
        } else if (type === 'heavy') {
            return this.scrapeWithPlaywright(url);
        } else {
            console.trace('Invalid fetch type specified. Please use "json", "heavy", or "default".');
            return null;
        }
    }

    /**
     * Legacy method - now uses the universal cloudscraper method
     */
    static async scrapeWithCloudScraper(url, options = {}) {
        console.log(`Fetching HTML from ${url}...`);
        
        const response = await this.cloudscraperGet(url, {
            headers: {
                Referer: Config.baseUrl,
                'Accept-Encoding': 'gzip, deflate, br',
                'dnt': '1',
                'sec-ch-ua': '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'x-requested-with': 'XMLHttpRequest',
                ...options.headers
            },
            timeout: options.timeout || 20000
        });

        return response.body;
    }

    static async scrapeWithPlaywright(url) {
        console.log('Fetching content from:', url);
        const proxy = Config.proxyEnabled ? Config.getRandomProxy() : null;
        console.log(`Using proxy: ${proxy || 'none'}`);

        const browser = await launchBrowser();

        try {
            const contextOptions = {};

            if (proxy) {
                contextOptions.proxy = { server: proxy };
            }

            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();

            // Stealth measures
            await page.addInitScript(() => {
                delete navigator.__proto__.webdriver;
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });

                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters);
            });

            // Realistic headers
            await page.setExtraHTTPHeaders({
                'User-Agent': Config.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
                'Cache-Control': 'no-cache',
            });

            console.log('Navigating to URL...');
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

            await page.waitForTimeout(10000); // DDoS challenge buffer

            const isApiRequest = url.includes('/api') || url.endsWith('.json');

            if (!isApiRequest) {
                try {
                    await page.waitForSelector('.episode-wrap, .episode-list', { timeout: 60000 });
                } catch (e) {
                    console.log('Selector not found, continuing...');
                }
            } else {
                try {
                    await page.waitForFunction(() => {
                        const text = document.body.textContent;
                        return text.includes('{') && text.includes('}');
                    }, { timeout: 60000 });
                } catch (e) {
                    console.log('API content not found, continuing...');
                }
            }

            const content = await page.content();
            return content;
        } finally {
            await browser.close();
        }
    }

    static async fetchJson(url) {
        const html = await this.fetch(url);
        
        try {
            // Try to parse the content as JSON
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

    static async fetchCloudflareProtected(url, options = {}) {
        console.log('Fetching Cloudflare-protected content from:', url);
        
        const proxy = Config.proxyEnabled ? Config.getRandomProxy() : null;
        console.log(`Using proxy: ${proxy || 'none'}`);

        const browser = await launchBrowser();

        try {
            const contextOptions = {
                userAgent: Config.userAgent,
                viewport: { width: 1920, height: 1080 },
                extraHTTPHeaders: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'cross-site',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'Referer': options.referer || Config.getUrl('home')
                }
            };

            if (proxy) {
                contextOptions.proxy = { server: proxy };
            }

            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();

            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

                // Add chrome object
                window.chrome = {
                    runtime: {},
                    loadTimes: function() {},
                    csi: function() {},
                    app: {}
                };

                // Mock permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission })
                        : originalQuery(parameters);
            });

            console.log('Navigating to URL...');
            await page.goto(url, { 
                waitUntil: 'domcontentloaded', 
                timeout: 60000 
            });

            // Handle Cloudflare challenge
            await this.handleCloudflareChallenge(page);

            const content = await page.content();
            await context.close();
            
            return content;
        } finally {
            await browser.close();
        }
    }

    static async handleCloudflareChallenge(page) {
        console.log('Checking for Cloudflare challenge...');
        
        // for any immediate redirects
        await page.waitForTimeout(3000);
        
        // Check for various challenge indicators
        const challengeSelectors = [
            '#cf-challenge-running',
            '.cf-challenge-form',
            '[data-ray]', // Cloudflare Ray ID
            'title:has-text("Just a moment")',
            'h1:has-text("Please wait")',
            'div:has-text("Checking your browser")',
            'div:has-text("DDoS protection")'
        ];

        let challengeFound = false;
        for (const selector of challengeSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    challengeFound = true;
                    console.log(`Challenge detected with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                // Continue checking other selectors
            }
        }

        if (challengeFound || page.url().includes('cdn-cgi/challenge')) {
            console.log('Cloudflare challenge detected, waiting for resolution...');
            
            try {
                await page.waitForFunction(() => {
                    const title = document.title.toLowerCase();
                    const url = window.location.href;
                    const bodyText = document.body.textContent.toLowerCase();
                    
                    // Check if we're no longer on a challenge page
                    return !title.includes('just a moment') && 
                        !title.includes('please wait') &&
                        !url.includes('cdn-cgi/challenge') &&
                        !bodyText.includes('checking your browser') &&
                        !bodyText.includes('ddos protection');
                }, { timeout: 30000 });
                
                console.log('Cloudflare challenge resolved successfully');
                
                // Additional wait to ensure page is fully loaded
                await page.waitForTimeout(2000);
                
            } catch (timeoutError) {
                console.warn('Challenge resolution timeout - proceeding anyway');
                // Don't throw error, let the caller handle the response
            }
        } else {
            console.log('No Cloudflare challenge detected');
        }
    }

    static async fetchApiData(url, params = {}, cookieHeader) {
        try {
            if (!cookieHeader) {
                throw new CustomError('DDoS-Guard authentication required', 403);
            }
            
            const proxyUrl = Config.proxyEnabled ? Config.getRandomProxy() : null;
            const [proxyHost, proxyPort] = proxyUrl ? proxyUrl.split(':') : [null, null];

            console.log(`Using proxy: ${proxyUrl || 'none'}`);
            if (proxyHost && !proxyPort) {
                throw new CustomError('Invalid proxy format. Expected format: host:port', 400);
            }

            const response = await axios.get(url, {
                params: params,
                headers: {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': Config.getUrl('home'),
                    'User-Agent': Config.userAgent,
                    'Accept-Language': 'en-US,en;q=0.9', 
                    'Sec-Fetch-*': '?', 
                    "dnt": "1",
                    "sec-ch-ua": '"Not A(Brand";v="99", "Microsoft Edge";v="121", "Chromium";v="121"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"Windows"',
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "x-requested-with": "XMLHttpRequest",
                    'Cookie': cookieHeader
                },
                proxy: proxyUrl ? {
                    host: proxyHost,
                    port: parseInt(proxyPort),
                    protocol: 'http'
                } : false
            });

            const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            if (responseText.includes('DDoS-GUARD') || 
                responseText.includes('checking your browser') ||
                response.status === 403) {
                console.log("response: ", responseText);
                throw new CustomError('DDoS-Guard authentication required, valid cookies required', 403);
            }

            return response.data;
        } catch (error) {
            if (error.response?.status === 403) {
                console.log(Config.cookies);
                throw new CustomError('DDoS-Guard authentication required, invalid cookies', 403);
            }
            if (error.response?.status === 404) {
                throw new CustomError('Resource not found', 404);
            }
            throw error;
        }
    }
}

module.exports = RequestManager;