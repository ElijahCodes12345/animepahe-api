const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { createCursor } = require('ghost-cursor');
const Config = require('./config');

/**
 * BrowserService
 *
 * Wraps patchright (patched Playwright) to bypass Cloudflare Turnstile /
 * managed challenges. Uses a persistent Chrome context so cf_clearance
 * cookies survive across requests.
 *
 * Public API:
 *   browserService.render(url, options)  → { content, cookies, url, status }
 *   browserService.fetch(url, options)   → { ...render, data }
 *
 * NOTE: patchright requires a real Chrome install and a GUI-capable host.
 *       It does NOT work on serverless platforms (Vercel, Netlify, etc.).
 */
class BrowserService {
    constructor() {
        /** @type {import('patchright').BrowserContext|null} */
        this.context = null;
        this._launchLock   = null;
        this._idleTimer    = null;
        this._idleTimeoutMs = 5 * 60 * 1000; // 5 minutes
        this._hooksRegistered = false;

        this._registerProcessHooks();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    _getChromePath() {
        const candidates = [
            process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
                : null,
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            process.env.CHROME_BIN || null,
        ].filter(Boolean);

        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return undefined; // let patchright discover its bundled browser
    }

    _getPlaywrightProxy() {
        if (!Config.proxyEnabled || Config.proxies.length === 0) return null;
        const raw = Config.getRandomProxy();
        if (!raw) return null;
        try {
            const formatted = raw.startsWith('http') ? raw : 'http://' + raw;
            const parsed    = new URL(formatted);
            return {
                server:   `${parsed.protocol}//${parsed.host}`,
                username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
                password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
            };
        } catch (_) {
            return { server: raw };
        }
    }

    /** Ensure the persistent browser context is running. */
    async _ensureContext(forceDirect = false) {
        this._resetIdleTimer();
        if (this.context) return this.context;
        if (this._launchLock) {
            await this._launchLock;
            return this.context;
        }
        this._launchLock = this._launch(forceDirect);
        try {
            this.context = await this._launchLock;
        } finally {
            this._launchLock = null;
        }
        this._resetIdleTimer();
        return this.context;
    }

    _resetIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
        this._idleTimer = setTimeout(async () => {
            if (this.context) {
                console.log('[BrowserService] 💤 Idle timeout reached (5m). Closing browser context...');
                await this.close();
            }
        }, this._idleTimeoutMs);
    }

    _registerProcessHooks() {
        if (this._hooksRegistered) return;
        this._hooksRegistered = true;

        const cleanup = () => {
            if (this.context) {
                console.log('[BrowserService] Process exiting. Closing browser context...');
                this.close().catch(() => {});
            }
        };

        process.once('exit',   cleanup);
        process.once('SIGINT',  () => { cleanup(); process.exit(0); });
        process.once('SIGTERM', () => { cleanup(); process.exit(0); });
        process.once('SIGHUP',  () => { cleanup(); process.exit(0); });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Browser launch
    // ─────────────────────────────────────────────────────────────────────────

    async _launch(forceDirect = false) {
        const { chromium } = require('patchright');
        const profileDir   = path.join(__dirname, '../.chrome-user-data-patchright');
        const execPath     = this._getChromePath();

        const args = [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1366,768',
            '--disable-infobars',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-notifications',
        ];

        const proxy = !forceDirect ? this._getPlaywrightProxy() : null;
        if (proxy?.server) console.log(`[BrowserService] Using proxy: ${proxy.server}`);

        console.log('[BrowserService] Launching Chrome via patchright...');

        // If Config.dataDir is set (by aniempire-api), we use that persistent profile location.
        // Otherwise, use our default local profileDir.
        const useDataDir = Config.dataDir || profileDir;

        const ctx = await chromium.launchPersistentContext(useDataDir, {
            executablePath: execPath,
            headless:       false,
            viewport:       { width: 1366, height: 768 },
            args,
            ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
            ...(proxy?.server ? { proxy } : {}),
        });

        console.log('[BrowserService] ✅ Context launched');
        await this._syncUserAgent(ctx);
        return ctx;
    }

    async _syncUserAgent(ctx) {
        try {
            const ua = await ctx.newPage().then(async p => {
                const agent = await p.evaluate(() => navigator.userAgent);
                await p.close();
                return agent;
            });
            if (ua) Config.userAgent = ua;
        } catch (_) {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Fetch a URL through Chrome, solving any Cloudflare challenge.
     * @returns {{ content, cookies, url, status, data }}
     */
    async fetch(url, options = {}) {
        const res = await this.render(url, options);
        if (options.responseType === 'json') {
            try {
                let body = res.content;
                const m  = body.match(/<pre[^>]*>(.*?)<\/pre>/s);
                if (m) body = m[1];
                body = body.replace(/<[^>]*>?/gm, '');
                return { ...res, data: JSON.parse(body) };
            } catch (_) {
                console.warn('[BrowserService] JSON parse failed, returning raw string');
                return { ...res, data: res.content };
            }
        }
        return { ...res, data: res.content };
    }

    /**
     * Navigate to a URL, solve CF challenge if present, return page content.
     * @returns {{ content, cookies, url, status }}
     */
    async render(url, options = {}) {
        const ctx = await this._ensureContext(!!options.forceDirect);
        const page = await ctx.newPage();

        const navTimeout = options.timeout || 120000;

        try {
            // Cookie freshness guard: clear expired cf_clearance before navigating
            // so Cloudflare issues a fresh (solvable) challenge instead of a hard one.
            const domainHost = new URL(url).hostname;
            const allCookies = await ctx.cookies().catch(() => []);
            const cfCookie   = allCookies.find(c =>
                c.name === 'cf_clearance' &&
                (c.domain === domainHost || c.domain === '.' + domainHost ||
                 domainHost.endsWith(c.domain.replace(/^\./, '')))
            );
            if (cfCookie) {
                const expiresMs = cfCookie.expires > 0 ? cfCookie.expires * 1000 : Infinity;
                const safetyMs  = 20 * 60 * 1000; // treat as expired 20 min early
                if (Date.now() + safetyMs >= expiresMs) {
                    const keep = allCookies.filter(c =>
                        c.domain !== domainHost && c.domain !== '.' + domainHost
                    );
                    await ctx.clearCookies().catch(() => {});
                    if (keep.length) await ctx.addCookies(keep).catch(() => {});
                    console.log(`[BrowserService] Cleared stale cf_clearance for ${domainHost}`);
                }
            }

            // Bring this page to front so Chrome shows the challenge (not the blank initial tab)
            await page.bringToFront().catch(() => {});

            try {
                // Cloudflare often returns HTTP 403/503 alongside the challenge page.
                // Playwright's goto() throws an error (e.g. ERR_HTTP_RESPONSE_CODE_FAILURE)
                // when it sees these error codes, even if the Turnstile page loaded fine.
                // We ignore all navigation errors here and let _solveChallenge inspect the page.
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            } catch (e) {
                console.log(`[BrowserService] Navigation error (ignoring): ${e.message.split('\\n')[0]}`);
            }

            await this._solveChallenge(page, url, navTimeout);

            // Post-solve guard: if still on CF challenge, one final networkidle navigate
            const postTitle = await page.title().catch(() => '');
            const postUrl   = page.url();
            if (postTitle.includes('Just a moment') ||
                postUrl.includes('cf_chl_rt_tk') ||
                postUrl.includes('cf_chl_f_tk')) {
                try { await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 }); } catch (_) {}
            }

            // Final check — if still challenged after all attempts, fail hard
            const finalTitle = await page.title().catch(() => '');
            const finalUrl   = page.url();
            if (finalTitle.includes('Just a moment') ||
                finalUrl.includes('cf_chl_rt_tk') ||
                finalUrl.includes('cf_chl_f_tk')) {
                throw new Error('[BrowserService] Could not bypass Cloudflare — still on challenge page');
            }

            const content = await page.content();
            const cookies = await ctx.cookies(url);

            return { content, cookies, url: finalUrl, status: 200 };
        } finally {
            await page.close().catch(() => {});
            this._resetIdleTimer();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Challenge solver
    // ─────────────────────────────────────────────────────────────────────────

    async _solveChallenge(page, originalUrl, timeout) {
        const t0 = Date.now();
        console.log(`[BrowserService] Starting challenge check for ${originalUrl}`);

        let reloadCount       = 0;
        let clearanceSeenAt   = null;
        let lastTurnstileClick = 0;

        let cursor = null;
        try {
            cursor = createCursor(page, { x: 400 + Math.random() * 400, y: 200 + Math.random() * 200 });
        } catch (_) {}

        while (Date.now() - t0 < timeout) {
            const title    = await page.title().catch(() => '');
            const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

            // page.content() throws if the page is mid-navigation (e.g. after a successful CF redirect).
            // Wait for it to settle rather than treating the empty string as a failure.
            let html = '';
            try {
                html = await page.content();
            } catch (e) {
                if (e.message.includes('navigating')) {
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                    html = await page.content().catch(() => '');
                }
            }
            const pageUrl  = page.url();

            const isCf = title.includes('Just a moment') ||
                          pageUrl.includes('cf_chl_rt_tk') ||
                          pageUrl.includes('cf_chl_f_tk') ||
                          html.includes('cf-please-wait') ||
                          (html.includes('ray-id') && html.includes('cf-error'));

            if (!isCf && (html.length > 500 || bodyText.length > 100)) {
                console.log(`[BrowserService] ✅ Bypassed (+${Date.now() - t0}ms)`);
                return;
            }

            const cookies      = await page.context().cookies(originalUrl).catch(() => []);
            const hasClearance = cookies.some(c => c.name === 'cf_clearance');

            if (hasClearance) {
                if (!clearanceSeenAt) {
                    console.log('[BrowserService] 🌟 cf_clearance acquired — waiting for page transition...');
                    clearanceSeenAt = Date.now();
                }

                // Wait 45s before first reload — each reload presents a harder fresh Turnstile
                if (Date.now() - clearanceSeenAt > 45000) {
                    if (reloadCount < 1) {
                        reloadCount++;
                        console.log(`[BrowserService] 🔄 Stuck with clearance — reloading (${reloadCount}/1)...`);
                        if (cursor) await cursor.moveTo({ x: 500 + Math.random() * 200, y: 300 + Math.random() * 200 }).catch(() => {});
                        try { await page.goto(originalUrl, { waitUntil: 'networkidle', timeout: 30000 }); } catch (_) {}
                        clearanceSeenAt = Date.now();
                        lastTurnstileClick = 0; // allow immediate click on fresh page
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    } else {
                        console.log(`[BrowserService] ⚠️  Returning with cf_clearance (title: "${title}", url: ${page.url()})`);
                        return;
                    }
                } else {
                    if (cursor && Math.random() > 0.5) {
                        await cursor.moveTo({ x: 400 + Math.random() * 400, y: 200 + Math.random() * 400 }).catch(() => {});
                    }
                }
            }

            // Try clicking Turnstile every 8s.
            // If the click lands, reset clearanceSeenAt so the reload timer
            // restarts — the page may already be transitioning away.
            if (Date.now() - lastTurnstileClick > 8000) {
                const clicked = await this._tryClickTurnstile(page, cursor);
                if (clicked && clearanceSeenAt) {
                    clearanceSeenAt = Date.now();
                }
                lastTurnstileClick = Date.now();
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        throw new Error(`[BrowserService] Challenge could not be resolved after ${timeout}ms`);
    }

    async _tryClickTurnstile(page, cursor) {
        try {
            const frames = page.frames();
            const turnstileFrames = frames.filter(f => {
                const u = f.url();
                return u.includes('challenges.cloudflare.com') || u.includes('turnstile');
            });

            if (turnstileFrames.length === 0) return false;

            for (const frame of turnstileFrames) {
                console.log(`[BrowserService] 🎯 Turnstile frame: ${frame.url().slice(0, 90)}`);

                // Wait for the widget's DOM to be ready before attempting to click
                await frame.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 800));

                // Method 1: click input[type="checkbox"] via locator (longer timeout to allow widget init)
                try {
                    const checkbox = frame.locator('input[type="checkbox"]');
                    if (await checkbox.count({ timeout: 4000 }) > 0) {
                        await checkbox.first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                        await checkbox.first().click({ delay: 80 + Math.random() * 120, timeout: 5000 });
                        console.log('[BrowserService] 👆 Clicked Turnstile checkbox via locator');
                        return true;
                    }
                } catch (_) {}

                // Method 2: click by bounding box of the iframe element
                const el  = await frame.frameElement().catch(() => null);
                if (!el) continue;
                const box = await el.boundingBox().catch(() => null);
                if (!box || box.width === 0 || box.height === 0) continue;

                const clickX = box.x + 25;
                const clickY = box.y + (box.height / 2);

                console.log(`[BrowserService] 👆 Clicking Turnstile (bbox) at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                if (cursor) await cursor.moveTo({ x: clickX, y: clickY }).catch(() => {});
                await page.mouse.click(clickX, clickY, { delay: 80 + Math.random() * 100 });
                return true;
            }
        } catch (_) {}
        return false;
    }


    /**
     * Gracefully close the browser context (e.g. on server shutdown).
     */
    async close() {
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
            console.log('[BrowserService] Context closed.');
        }
    }
}

module.exports = new BrowserService();
