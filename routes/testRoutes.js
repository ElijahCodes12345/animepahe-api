const express = require('express');
const router = express.Router();
const { launchBrowser } = require('../utils/browser');

router.get('/test', async (req, res) => {
    try {
        const playPageUrl = 'https://animepahe.ru/play/9a16dfb8-8ffc-a0b0-6508-1b291afa04a7/b3a2934c2694eb256d0258ea1fea00dbf620eddd57cbadb97bec7019dc18dcc9';

        const browser = await launchBrowser();
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            javaScriptEnabled: true,
            // Add extra headers to appear more like a real browser
            extraHTTPHeaders: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            }
        });

        const cookies = await context.cookies();
        const relevantCookies = cookies.filter(cookie => 
            cookie.name.includes('cf_clearance') || 
            cookie.name.includes('srvs') ||
            cookie.name.includes('__cf') ||
            cookie.name.includes('_cflb') ||
            cookie.domain.includes('kwik.si') ||
            cookie.domain.includes('.si')
        );

        console.log(relevantCookies);

        const page = await context.newPage();

        // Enhanced stealth protections
        await page.addInitScript(() => {
            // Hide webdriver property
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            
            // Mock plugins
            Object.defineProperty(navigator, 'plugins', { 
                get: () => [
                    { name: 'Chrome PDF Plugin' },
                    { name: 'Chrome PDF Viewer' },
                    { name: 'Native Client' }
                ] 
            });
            
            // Mock languages
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            
            // Mock chrome object
            window.chrome = { runtime: {} };
            
            // Mock permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );

            // Mock screen properties
            Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
            
            // Remove automation indicators
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        });

        // Block ads and tracking
        await page.route('**/*', (route) => {
            const url = route.request().url();
            if (/ads|doubleclick|popunder|popads|brunetsmolted|duelistdoesnt|kryptonnutlet|whitebit|garsilgilpey|analytics|googletagmanager|facebook|twitter/.test(url)) {
                return route.abort();
            }
            route.continue();
        });

        console.log('Navigating to Animepahe...');
        await page.goto(playPageUrl, { waitUntil: 'networkidle', timeout: 60000 });
        
        // Wait a bit for any initial scripts to load
        await page.waitForTimeout(3000);

        let kwikResponse = null;
        let kwikUrl = null;

        // Enhanced route interception with better headers
        await page.route('**/kwik.si/e/**', async (route) => {
            const url = route.request().url();
            console.log('🎯 Intercepting kwik route:', url);
            kwikUrl = url;
            
            try {
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const response = await route.fetch({
                    headers: {
                        ...route.request().headers(),
                        'Referer': playPageUrl,
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
                    console.log('⚠️ Received Cloudflare challenge, trying alternative approach...');
                    
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
                            }
                        } catch (err) {
                            console.error('Delayed fetch failed:', err.message);
                        }
                    }, 5000);
                    
                } else {
                    kwikResponse = responseText;
                    console.log('✅ Captured kwik response via route interception');
                    
                    await route.fulfill({
                        response: response
                    });
                }
                
            } catch (err) {
                console.error('Route interception failed:', err.message);
                route.continue();
            }
        });

        // Click the load button
        await page.waitForSelector('.click-to-load .reload', { timeout: 45000 });
        await page.click('.click-to-load .reload');
        console.log('Clicked load button, waiting for kwik response...');

        // Wait longer for Cloudflare bypass
        const maxWait = 60000; 
        const interval = 2000;
        let elapsed = 0;

        while (!kwikResponse && elapsed < maxWait) {
            await page.waitForTimeout(interval);
            elapsed += interval;
            console.log(`Waiting for kwik response... ${elapsed / 1000}s`);
            
            // Try alternative approach if we're waiting too long
            if (elapsed === 20000 && kwikUrl && !kwikResponse) {
                console.log('🔄 Trying direct iframe navigation...');
                try {
                    // Navigate to the kwik URL directly in a new page
                    const kwikPage = await context.newPage();
                    await kwikPage.goto(kwikUrl, { waitUntil: 'networkidle', timeout: 30000 });
                    
                    // Wait for Cloudflare challenge to complete
                    await kwikPage.waitForTimeout(10000);
                    
                    const content = await kwikPage.content();
                    if (!content.includes('Just a moment')) {
                        kwikResponse = content;
                        console.log('✅ Successfully got content via direct navigation');
                        console.log("Cookies", cookies);
                    }
                    
                    await kwikPage.close();
                } catch (err) {
                    console.error('Direct navigation failed:', err.message);
                }
            }
        }

        await browser.close();

        if (!kwikResponse) {
            throw new Error(`kwik response not captured within time limit. URL detected: ${kwikUrl || 'none'}`);
        }

        // Check if we still have Cloudflare challenge in the response
        if (kwikResponse.includes('Just a moment') || kwikResponse.includes('Checking your browser')) {
            return res.status(202).json({
                message: 'Cloudflare challenge detected',
                kwikUrl: kwikUrl,
                note: 'Try again in a few moments or implement additional bypass techniques',
                preview: kwikResponse.slice(0, 500)
            });
        }

        // Extract video URL from kwik.si page
        let videoUrl = null;
        let extractedData = {};

        try {
            // Look for common video URL patterns in kwik.si
            const videoUrlMatches = kwikResponse.match(/source.*?src=["']([^"']+)["']/i) ||
                                  kwikResponse.match(/file:\s*["']([^"']+)["']/i) ||
                                  kwikResponse.match(/src=["']([^"']+\.mp4[^"']*)["']/i) ||
                                  kwikResponse.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);

            if (videoUrlMatches) {
                videoUrl = videoUrlMatches[1] || videoUrlMatches[0];
                extractedData.videoUrl = videoUrl;
            }

            // Look for video title
            const titleMatch = kwikResponse.match(/<title>([^<]+)<\/title>/i);
            if (titleMatch) {
                extractedData.title = titleMatch[1].replace(/\.mp4$/, '');
            }

            // Look for Plyr or other video player configurations
            const plyrMatch = kwikResponse.match(/new\s+Plyr[^{]*{[^}]*source[^}]*}[^}]*}/i);
            if (plyrMatch) {
                extractedData.playerConfig = plyrMatch[0];
            }

            // Look for JavaScript video source assignments
            const jsVideoMatch = kwikResponse.match(/video\.src\s*=\s*["']([^"']+)["']/i) ||
                                kwikResponse.match(/setAttribute\s*\(\s*["']src["']\s*,\s*["']([^"']+)["']/i);
            if (jsVideoMatch) {
                extractedData.jsVideoSrc = jsVideoMatch[1];
                if (!videoUrl) videoUrl = jsVideoMatch[1];
            }

        } catch (parseError) {
            console.error('Error parsing kwik response:', parseError.message);
        }

        return res.json({
            message: 'Success',
            kwikUrl: kwikUrl,
            videoUrl: videoUrl,
            extractedData: extractedData,
            preview: kwikResponse.slice(0, 500),
            contentLength: kwikResponse.length,
            captureMethod: 'Enhanced route interception with Cloudflare bypass',
            hasVideoUrl: !!videoUrl
        });

    } catch (error) {
        console.error('Error in /test:', error.message);
        return res.status(500).json({ 
            error: error.message,
            details: 'Check server logs for more information'
        });
    }
});

module.exports = router;

// const express = require('express');
// const router = express.Router();
// const { launchBrowser } = require('../utils/browser');

// router.get('/test', async (req, res) => {
//     res.status(200).json({ message: "A testing route"});
// });

// module.exports = router;
