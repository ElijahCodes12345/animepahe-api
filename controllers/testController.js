const cloudscraper = require('cloudscraper');
const axios = require('axios');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { CustomError } = require('../middleware/errorHandler');
const Config = require('../utils/config');

// Helper to wait
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class TestController {
    static async resolveKwik(req, res, next) {
        try {
            const { url } = req.query;

            if(!url) {
                throw new CustomError('Url is required', 400);
            }

            const result = await resolveKwik(url);
            console.log('\nOutput snapshot:\n', result);
            
            return res.json(result);
        } catch (err) {
            console.error('eval error', err && err.message);
            next(err);
        }
    }

    static async download(req, res, next) {
        try {
            const { url } = req.query;
            if (!url) {
                throw new CustomError('Url is required', 400);
            }
            
            // First, extract the actual Kwik URL from the HTML
            const resolvedUrl = await extractKwikUrl(url);
            if (!resolvedUrl) {
                // If can't extract the URL, try the original URL
                const downloadUrl = await getKwikDownloadUrl(url);
                return res.json({ downloadUrl, type: 'direct_download' });
            }
            
            console.log('Found Kwik URL:', resolvedUrl);
            
            // Use the extracted URL for getting the download link
            const downloadUrl = await getKwikDownloadUrl(resolvedUrl);
            return res.json({ downloadUrl, type: 'redirected_download', originalUrl: url, resolvedUrl });
            
        } catch (err) {
            console.error('Error downloading:', err && err.message);
            next(err);
        }
    }
}

// Function to extract Kwik URL from HTML content
async function extractKwikUrl(url) {
    try {
        console.log('[Step 1] Fetching page to extract Kwik URL:', url);
        
        const response = await cloudscraper.get({
            uri: url,
            headers: {
                Referer: "https://animepahe.si/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Connection": "keep-alive",
            },
            resolveWithFullResponse: true,
            timeout: 30000,
        });

        console.log("Page fetched for extraction, status:", response.statusCode);
        
        const body = response.body;
        
        // Pattern 1: Look for the specific script pattern with redirect href
        const redirectPattern = /href\s*:\s*["']([^"']+)["']/i;
        const redirectMatch = body.match(redirectPattern);
        if (redirectMatch && redirectMatch[1] && redirectMatch[1].includes(Config.iframeBaseUrl)) {
            console.log('Found redirect URL:', redirectMatch[1]);
            return redirectMatch[1];
        }
        
        // Pattern 2...
        // Dynamic construction
        const inputDomain = Config.iframeBaseUrl.replace('.', '\\.');
        const scriptPattern = new RegExp(`href["']\\s*,\\s*["']([^"']+\\.(?:${inputDomain}|${inputDomain.replace('\\.', '')}))[^"']*["']`, 'i');
        const scriptMatch = body.match(scriptPattern);
        if (scriptMatch && scriptMatch[1]) {
            // If it's a relative URL, make it absolute
            let kwikUrl = scriptMatch[1];
            if (kwikUrl.startsWith('/')) {
                const urlObj = new URL(url);
                kwikUrl = urlObj.protocol + '//' + urlObj.host + kwikUrl;
            } else if (!kwikUrl.startsWith('http')) {
                kwikUrl = `https://${Config.iframeBaseUrl}${kwikUrl}`;
            }
            console.log('Found Kwik URL from script:', kwikUrl);
            return kwikUrl;
        }
        
        // Pattern 3: Look for kwik.cx URLs in href attributes
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
            return kwikUrl;
        }
        
        // Pattern 4: Look for kwik.cx URLs in JavaScript redirects
        const jsRedirectPattern = new RegExp(`["'](https?:\\/\\/[^"']*${inputDomain}[^"']*)["']`, 'i');
        const jsMatch = body.match(jsRedirectPattern);
        if (jsMatch && jsMatch[1]) {
            console.log('Found Kwik URL from JavaScript:', jsMatch[1]);
            return jsMatch[1];
        }
        
        // Pattern 5: Look for the specific script pattern you mentioned
        const specificPattern = new RegExp(`href"\\s*,\\s*"([^"]*${inputDomain}[^"]*)"`);
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

async function getKwikDownloadUrl(url) {
    console.log("[Step 2] Fetching page for download link:", url);

    const getResponse = await cloudscraper.get({
        uri: url,
        headers: {
            Referer: "https://animepahe.si/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Connection": "keep-alive",
        },
        resolveWithFullResponse: true,
        timeout: 30000,
    });

    console.log("[✓] Page fetched, status:", getResponse.statusCode);
    
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
    
    // Check for serverless deployment platforms (matching browser.js logic)
    const isServerless = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
    
    if (isServerless) {
        // On serverless platforms, use cloudscraper to bypass Cloudflare
        console.log("[Running on serverless platform - using cloudscraper for POST]");
        
        try {
            const postResponse = await cloudscraper({
                method: 'POST',
                uri: foundAction,
                form: {
                    _token: foundToken
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": `https://${Config.iframeBaseUrl}`,
                    "Referer": url,
                    "Cookie": cookies,
                },
                followAllRedirects: false,
                followRedirect: false,
                simple: false,
                resolveWithFullResponse: true,
                timeout: 30000,
            });

            console.log("[Step 6] Response status:", postResponse.statusCode);

            if (postResponse.statusCode === 302 || postResponse.statusCode === 301) {
                const downloadUrl = postResponse.headers.location;
                console.log("Final download URL:", downloadUrl);
                return downloadUrl;
            } else if (postResponse.statusCode === 200) {
                // Check for redirects in the body
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
            console.log("[Cloudscraper Error]:", error.message);
            if (error.statusCode === 302 || error.statusCode === 301) {
                const downloadUrl = error.response?.headers?.location;
                if (downloadUrl) {
                    console.log("Final download URL (from error):", downloadUrl);
                    return downloadUrl;
                }
            }
            throw error;
        }
    } else {
        // Local development - use axios which works reliably
        console.log("[Running locally - using axios for POST]");
        
        try {
            const postResponse = await axios.post(
                foundAction,
                `_token=${encodeURIComponent(foundToken)}`,
                {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.5",
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Origin": `https://${Config.iframeBaseUrl}`,
                        "Referer": url,
                        "Cookie": cookies,
                        "Connection": "keep-alive",
                        "Upgrade-Insecure-Requests": "1",
                    },
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400,
                    timeout: 30000,
                }
            );

            console.log("[Step 6] Response status:", postResponse.status);

            if (postResponse.status === 302 || postResponse.status === 301) {
                const downloadUrl = postResponse.headers.location;
                console.log("Final download URL:", downloadUrl);
                return downloadUrl;
            } else if (postResponse.status === 200) {
                const metaMatch = postResponse.data.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"]*url=([^"']+)["']/i);
                if (metaMatch) {
                    console.log("Found meta refresh URL:", metaMatch[1]);
                    return metaMatch[1];
                }
                
                const jsMatch = postResponse.data.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
                if (jsMatch) {
                    console.log("Found JavaScript redirect URL:", jsMatch[1]);
                    return jsMatch[1];
                }

                console.log("[Response body snippet]:", postResponse.data.substring(0, 800));
            }
        } catch (error) {
            if (error.response) {
                console.log("[Error Response] Status:", error.response.status);
                
                if (error.response.status === 302 || error.response.status === 301) {
                    const downloadUrl = error.response.headers.location;
                    console.log("Final download URL (from error):", downloadUrl);
                    return downloadUrl;
                }
                
                console.log("[Error Response Body]:", error.response.data ? error.response.data.substring(0, 800) : "No body");
            } else {
                console.log("[Error]:", error.message);
            }
            throw error;
        }
    }

    throw new Error("Could not extract download URL");
}

async function resolveKwik(url) {
    console.log(`Fetching HTML from ${url}...`);

    const html = await cloudscraper.get(url, {
        headers: {
            Referer: 'https://animepahe.si/',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeout: 20000,
    });

    console.log('Fetched HTML successfully.');

    // collect inline script blocks
    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    if (!scriptMatches.length) {
        console.log('No inline <script> blocks found.');
        return null;
    }
    console.log(`Found ${scriptMatches.length} script tags.`);

    // helper to extract m3u8 from a string
    const findM3u8 = (s) => {
        if (!s) return null;
        const m = s.match(/https?:\/\/[^"'<> \n\r]+\.m3u8[^\s"'<>]*/i);
        return m ? m[0] : null;
    };

    for (const script of scriptMatches) {
        if (!script.includes('eval(')) continue; // only interested in obfuscated eval scripts

        console.log('Evaluating candidate script via vm sandbox...');

        // create minimal DOM with a <video> element that supports .src
        const dom = new JSDOM(`<!DOCTYPE html><video id="player"></video>`);
        const document = dom.window.document;
        const videoEl = document.querySelector('video');

        // capture storage
        const captured = new Set();

        // Plyr stub: capture provided source if present in options
        const Plyr = function (el, opts) {
            try {
                if (opts && opts.sources && Array.isArray(opts.sources)) {
                    for (const s of opts.sources) {
                        if (s && typeof s.src === 'string' && s.src.includes('.m3u8')) captured.add(s.src);
                    }
                }
            } catch (e) { /* ignore */ }
            return {
                on: () => {},
            };
        };

        // Hls stub: constructor + static isSupported
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
            navigator: { userAgent: 'mozilla' },
            location: { href: url },
            Plyr,
            Hls,
            setTimeout,
            clearTimeout,
        };

        // Create context
        vm.createContext(sandbox);

        // Run script and also try to unwrap one level of nested evals if found
        try {
            // Run once
            vm.runInContext(script, sandbox, { timeout: 2000 });
        } catch (err) {
            console.log('Eval failed:', err && err.message);
        }

        // Some pages embed further eval inside strings. Try to detect `eval(function(...` pattern and run inner body(s)
        // We search the script text for eval and then try to extract common packed patterns. This is best-effort.
        const innerEvalBodies = [];
        // pattern to capture eval\\(function...packed...) or eval\\(p,a,c,k,e,d\\)\\(...\\)
        const packedMatch = script.match(/eval\\((function[\s\S]*?)\\)\\s*;?/i);
        if (packedMatch && packedMatch[1]) innerEvalBodies.push(packedMatch[1]);
        // also check for common eval\\(\\(function\\(p,a,c,k,e,d\\)\\{[\\s\\S]*?\\}\\('[\\s\\S]*?'\\)\\)\\)
        const genericMatches = [...script.matchAll(/eval\\(([\\s\S]*?)\\)\\s*;?/gi)];
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
            return arr[0];
        }

        // 2) check video element src
        try {
            const vsrc = videoEl && videoEl.src;
            const found = findM3u8(vsrc);
            if (found) {
                console.log('Resolved m3u8 (video.src):', found);
                return found;
            }
        } catch (e) { /* ignore */ }

        // 3) check sandbox.window / sandbox.document for q or other variables
        try {
            const pkg = JSON.stringify(sandbox);
            const found = findM3u8(pkg);
            if (found) {
                console.log('Resolved m3u8 (sandbox JSON):', found);
                return found;
            }
        } catch (e) { /* ignore */ }

        // 4) finally scan the original script text for direct m3u8 (rare if obfuscated)
        const fromScript = findM3u8(script);
        if (fromScript) {
            console.log('Resolved m3u8 (script literal):', fromScript);
            return fromScript;
        }

        console.log('Could not resolve m3u8 from this script, continuing to next candidate...');
    }

    // fallback: try data-src attribute in html (in case)
    const fallback = html.match(/data-src="([^"]+\.m3u8[^"]*)"/i);
    if (fallback) {
        console.log('FOUND data-src m3u8 (fallback):', fallback[1]);
        return fallback[1];
    }

    console.log('Could not resolve m3u8 from any Kwik script.');
    return null;
}

module.exports = TestController;