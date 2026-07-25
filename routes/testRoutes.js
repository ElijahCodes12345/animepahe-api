const express = require('express');
const router = express.Router();
const TestController = require('../controllers/testController');
const BrowserService = require('../utils/browser');


router.get('/kwik-test', TestController.resolveKwik);

router.get('/downlod-test', TestController.download);

router.get('/test', async (req, res) => {
    try {
        const testUrl = req.query.url || 'https://animepahe.si';

        console.log(`[Test] Rendering ${testUrl} via BrowserService...`);
        const result = await BrowserService.render(testUrl, { timeout: 120000 });

        const cfCookie = result.cookies.find(c => c.name === 'cf_clearance');
        const hasCfChallenge = result.content.includes('Just a moment') ||
                               result.content.includes('Checking your browser');

        return res.json({
            message: hasCfChallenge ? 'Cloudflare challenge still active' : 'Success',
            url: result.url,
            status: result.status,
            contentLength: result.content.length,
            hasCfClearance: !!cfCookie,
            cfClearanceExpires: cfCookie ? new Date(cfCookie.expires * 1000).toISOString() : null,
            cookieCount: result.cookies.length,
            preview: result.content.slice(0, 500),
        });
    } catch (error) {
        console.error('[Test] Error:', error.message);
        return res.status(500).json({
            error: error.message,
            details: 'Check server logs for more information',
        });
    }
});

module.exports = router;
