const express = require('express');
const cors = require('cors');
const Config = require('../utils/config');
const { errorHandler, CustomError } = require('../middleware/errorHandler');
const homeRoutes = require('../routes/homeRoutes');
const queueRoutes = require('../routes/queueRoutes');
const animeListRoutes = require('../routes/animeListRoutes');
const animeInfoRoutes = require('../routes/animeInfoRoutes');
const playRoutes = require('../routes/playRoutes');
const cache = require('../middleware/cache');
const testRoutes = require('../routes/testRoutes');

const app = express();

// Load environment variables into Config
try {
    Config.validate();
    Config.loadFromEnv();
    console.log('\x1b[36m%s\x1b[0m', 'Configuration set!.');
} catch (error) {
    console.error(error.message);
    throw error;
}

// CORS Configuration
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : ['*']; // Default: allow all origins
        
        if (allowedOrigins.includes('*')) {
            return callback(null, true);
        }
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));

// Middleware to set hostUrl
app.use((req, res, next) => {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    Config.setHostUrl(protocol, host);
    next();
});

app.use('/api', testRoutes);
app.use('/api', homeRoutes); // caching done in homeRoutes
app.use('/api', cache(30), queueRoutes); // 30 seconds
app.use('/api', cache(18000), animeListRoutes); // 1 hour
app.use('/api', cache(86400), animeInfoRoutes); // 1 day
app.use('/api', cache(3600), playRoutes);  // 5 hours

app.use((req, res, next) => {
    if (!req.route) {
        next(new CustomError('Route not found. Please check the API documentation at https://github.com/ElijahCodes12345/animepahe-api', 404));
    } else {
        next();
    }
});

// Error handling middleware
app.use(errorHandler);

module.exports = app.handler = (req, res) => {
    let path = req.url.replace(/^\/api/, '');
    if (!path.startsWith('/')) {
        path = '/' + path;
    }
    req.url = '/api' + path;
    return app(req, res);
};