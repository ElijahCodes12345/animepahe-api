const redis = require('../utils/redis');

const cache = (duration) => async (req, res, next) => {
    // caching will be skipped if Redis is disabled
    if (!redis.enabled) {
        return next();
    }

    try {
        // Build a normalized cache key: path + sorted query params
        let key = req.path;
        const queryKeys = Object.keys(req.query);
        if (queryKeys.length > 0) {
            const sortedQuery = queryKeys
                .sort()
                .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(req.query[k])}`)
                .join('&');
            key += `?${sortedQuery}`;
        }

        const cachedResponse = await redis.get(key);

        if (cachedResponse) {
            return res.json(JSON.parse(cachedResponse));
        }

        const originalJson = res.json;
        
        res.json = async function(data) {
            await redis.setEx(key, duration, JSON.stringify(data));
            return originalJson.call(this, data);
        };

        next();
    } catch (error) {
        console.error('Cache error:', error);
        next();
    }
};

module.exports = cache;