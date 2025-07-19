const express = require('express');
const router = express.Router();

router.get('/test', (req, res) => {
    (async () => {
        const iframeUrl = 'https://kwik.si/e/47CpMt1VbJwL'; // Replace with your URL
        // const cookies = await solveCloudflareAndGetCookies(iframeUrl);

        // ✅ You can now use cookies in axios:
        const axios = require('axios');
        const response = await axios.get(iframeUrl, {
            headers: {
                Referer: "https://animepahe.ru/",
                "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
                Cookie: "cf_clearance=FErVX1qJxP7oAz7PfbGNnfGBJRM.kLHF4xZvDU4gl2c-1752869611-1.2.1.1-mx4Pd4OfoXBdx4BGsokX1sktvX9Gnz1rNHTpqCZ4mUYRvIbNIzFfI9oReTz0hbu5CK0DvsiGCBUaTEsiK1Rqqqqz2d7EaD9N1hMEFNx80CclVJWMBiZOhtXkfnEOqBV1dAXeKVDlYjaiTL0xtFNYUxDnINV_dm1D1Yr6pMr96rPDJs9ju4oSBgFl609J9Uxxy4.PSZHA6A0DEqWeQShCK6SL_qdhRiX37XFv17n1S90;kwik_session=kwik_session=eyJpdiI6ImhpeG9mbzNTQmNXOW9nTU1TRHA5MFE9PSIsInZhbHVlIjoiSmFxcFV3NFVXSThOamNSM2ZGUTk4YnIrMU04UVVNeU5wNTcwWjU0MU9BcXp2T3dIb3JrM0pPN3ZqaGZHUnIyaVpjMmVaSzZ2Ri9TS3E1RXk2WmVxRnJjNTYwK25jVTR5THFkNHRKbFd3aXdZRG9GYVZaWDFDSmFCNXBTaHhKbi8iLCJtYWMiOiIxMWRjYzYzNWI0YzAwYmNkZTBiNmQ1MDhlYTg3MmY0ODliZjAxNGI5MzlkNjRhMjM0NDQ1YjQ4M2IwZTJmYzQwIiwidGFnIjoiIn0%3D;srv=s0;",
            },
        });

        console.log("✅ Request Headers Sent:");
        console.log(response.config.headers); // what was sent
        console.log("\n✅ Response Headers:");
        console.log(response.headers); // what came back
        console.log("\n✅ Status:", response.status);
        console.log("\n✅ Response HTML (truncated):");
        console.log(response.data.slice(0, 500)); // first 500 chars
        const data = response.data;

        return res.json({ data });
    })();
});

module.exports = router;
