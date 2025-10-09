const cloudscraper = require('cloudscraper');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { CustomError } = require('../middleware/errorHandler');

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
    // We search the script text for eval( and then try to extract common packed patterns. This is best-effort.
    const innerEvalBodies = [];
    // pattern to capture eval\(function...packed...) or eval\(p,a,c,k,e,d\)\(...)
    const packedMatch = script.match(/eval\((function[\s\S]*?)\)\s*;?/i);
    if (packedMatch && packedMatch[1]) innerEvalBodies.push(packedMatch[1]);
    // also check for common eval\(\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('[\s\S]*?'\)\)
    const genericMatches = [...script.matchAll(/eval\(([\s\S]*?)\)\s*;?/gi)];
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