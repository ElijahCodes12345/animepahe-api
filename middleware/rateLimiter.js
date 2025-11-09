const { redisClient, get, setEx, enabled } = require('../utils/redis');

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '100'); // requests per window
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '900'); // seconds (15 minutes)
const RATE_LIMIT_SECRET = process.env.RATE_LIMIT_SECRET; // Only enable if this secret is set
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

const rateLimiter = async (req, res, next) => {
    //rate limiting if both the secret is set AND Redis is enabled
    if (!RATE_LIMIT_SECRET || !enabled) {
        // Skip rate limiting if no secret is set or Redis is not enabled
        if (!enabled) {
            console.warn('Redis not enabled, skipping rate limiting');
        }
        return next();
    }

    // Skip rate limiting for health checks and other internal routes. Routes doesn't exist tbf, just incase
    if (req.path === '/api/health' || req.path === '/api/status') {
        return next();
    }

    try {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                  req.headers['x-real-ip'] || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress ||
                  (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
                  'unknown';

        if (ip === 'unknown') {
            console.warn('Could not determine client IP address');
            return next();
        }

        const key = `rate-limit:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;
        const currentCount = await get(key);

        if (currentCount === null) {
            // First request in this window, set counter with expiration
            await setEx(key, RATE_LIMIT_WINDOW, '1');
            res.setHeader('X-RateLimit-Remaining', RATE_LIMIT_MAX - 1);
            res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
            res.setHeader('X-RateLimit-Reset', new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString());
            return next();
        }

        const count = parseInt(currentCount);

        if (count >= RATE_LIMIT_MAX) {
            // Rate limit exceeded
            res.status(429).json({
                error: 'Rate limit exceeded. Please try again later.',
                message: `Too many requests from this IP. Limit is ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW} seconds.`,
                retryAfter: RATE_LIMIT_WINDOW
            });
            return;
        }

        // Increment counter
        await setEx(key, RATE_LIMIT_WINDOW, (count + 1).toString());
        res.setHeader('X-RateLimit-Remaining', RATE_LIMIT_MAX - count - 1);
        res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString());

        return next();
    } catch (error) {
        console.error('Rate limiting error:', error);
        return next();
    }
};

module.exports = rateLimiter;