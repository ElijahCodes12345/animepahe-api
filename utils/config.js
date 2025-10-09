const dotenv = require('dotenv');
dotenv.config();

class Config {
    constructor() {
        this.hostUrl = '';
        this.baseUrl = 'https://animepahe.si'; 
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        this.extraHTTPHeaders = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }
        this.cookies = '';
        this.cookiesRefreshInterval = 14 * 24 * 60 * 60 * 1000;
        this.proxies = [];
        this.proxyEnabled = false;
        
        // Environment-specific settings
        this.isServerless = !!(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
        this.maxRetries = this.isServerless ? 1 : 3; // Reduced retries on Vercel
        this.requestTimeout = this.isServerless ? 10000 : 30000; // Reduced timeout on Vercel
        this.challengeTimeout = this.isServerless ? 10000 : 30000; // Reduced timeout on Vercel
    }

    setHostUrl(protocol, host) {
        if (!this.hostUrl && protocol && host) {
          this.hostUrl = `${protocol}://${host}`;
          console.log(`Host URL set to: ${this.hostUrl}`);
        }
    }

    setCookies(cookieHeader) {
        if(!cookieHeader) {
            console.warn("Warning: Cookie Header is missing or empty");
            return false;
        }
        
        try {
            if(typeof cookieHeader === 'string' && cookieHeader.includes('=')) {
                this.cookies = cookieHeader;
                console.log('\x1b[36m%s\x1b[0m', 'Cookies successfully set');
                return true;
            } else {
                console.warn("Warning: Invalid cookie format");
                return false;
            }
        } catch(error) {
            console.error("Error setting cookies:", error.message);
            return false;
        }
    }

    setProxy(proxyString) {
        if(!proxyString) {
            console.warn("Warning: Proxy string is empty");
            return false;
        }

        try {
            // Validate proxy format (basic check)
            const proxyUrl = new URL(proxyString.startsWith('http') ? proxyString : `http://${proxyString}`);
            if(proxyUrl.hostname) {
                return true;
            }
            return false;
        } catch(error) {
            console.warn(`Invalid proxy format: ${proxyString}`);
            return false;
        }
    }

    getRandomProxy() {
        if (this.proxies.length === 0) {
            console.log('No proxies available.');
        }
        return this.proxies[Math.floor(Math.random() * this.proxies.length)];
    }

    // Method to update proxies dynamically
    updateProxies(newProxies) {
        this.proxies = newProxies;
    }

    getUrl(section, primary = '', secondary = '') {
        const paths = {
            home: '/',
            queue: '/queue',
            animeInfo: `/anime/${primary}`, 
            animeList: primary && secondary ? `/anime/${primary}/${secondary}` : '/anime', 
            play: `/play/${primary}/${secondary}`
        };

        if (!paths[section]) {
            throw new Error(`Invalid section: ${section}`);
        }

        return `${this.baseUrl}${paths[section]}`;
    }

    loadFromEnv() {
        if (process.env.BASE_URL) {
            this.baseUrl = process.env.BASE_URL;
        }
        
        if (process.env.USER_AGENT) {
            this.userAgent = process.env.USER_AGENT;
        }
        
        if (process.env.HOST_URL) {
            this.hostUrl = process.env.HOST_URL;
        }

        if (process.env.cookiesRefreshInterval) {
            this.cookiesRefreshInterval = process.env.cookiesRefreshInterval;
        }

        // Handle cookies
        if (process.env.COOKIES) {
            const cookiePattern = /^([^=]+=[^;]+)(; [^=]+=[^;]+)*$/;
            if (!cookiePattern.test(process.env.COOKIES)) {
                console.warn("Invalid cookie format in environment variables");
            }
            console.log("Setting cookies from environment variables...", process.env.COOKIES);
            const cookiesSet = this.setCookies(process.env.COOKIES);
            if (!cookiesSet) {
                console.warn("Failed to set cookies from environment variables");
            }
        }

        // Handle proxies
        if (process.env.PROXIES) {
            try {
                const proxyList = process.env.PROXIES.split(',').map(proxy => proxy.trim());
                const validProxies = proxyList.filter(proxy => this.setProxy(proxy));
                
                if (validProxies.length === 0) {
                    console.warn("No valid proxies found in environment variables");
                    this.proxies = [];
                } else {
                    this.proxies = validProxies;
                    console.log(`Successfully loaded ${validProxies.length} proxies`);
                }
            } catch (error) {
                console.error("Error processing proxies from environment variables:", error.message);
                this.proxies = [];
            }
        }

        this.proxyEnabled = process.env.USE_PROXY === 'true';
        if (this.proxyEnabled && this.proxies.length === 0) {
            console.warn("Proxy usage is enabled but no valid proxies are configured");
        }
    }

    validate() {
        if (!this.baseUrl) {
            throw new Error('Base URL is required in configuration.');
        }
        if (!this.userAgent) {
            throw new Error('User-Agent is required in configuration.');
        }
    }
}

const config = new Config();
module.exports = config;