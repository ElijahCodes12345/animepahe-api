/**
 * AnimePahe API - Node.js Library
 * ================================
 * This file serves as the entry point for using animepahe-api as a library.
 * 
 * Install: npm install github:ElijahCodes12345/animepahe-api
 * 
 * Usage:
 *   const animepahe = require('animepahe-api');
 *   const results = await animepahe.search('Naruto');
 */

// Core Scraper (Singleton)
const Animepahe = require('./scrapers/animepahe');

// Models (Business Logic)
const HomeModel = require('./models/homeModel');
const AnimeInfoModel = require('./models/animeInfoModel');
const AnimeListModel = require('./models/animeListModel');
const PlayModel = require('./models/playModel');
const QueueModel = require('./models/queueModel');

// Config Utility (for setting cookies, base URL, etc.)
const Config = require('./utils/config');

/**
 * Initialize the library.
 * Call this once before using any scraping functions if you need to refresh cookies.
 * @returns {Promise<boolean>}
 */
async function initialize() {
    return Animepahe.initialize();
}

/**
 * Search for anime by title.
 * @param {string} query - The search term
 * @param {number} [page=1] - Page number for pagination
 * @returns {Promise<object>} - Search results
 */
async function search(query, page = 1) {
    return HomeModel.searchAnime(query, page);
}

/**
 * Get currently airing anime.
 * @param {number} [page=1] - Page number for pagination
 * @returns {Promise<object>} - Airing anime list
 */
async function getAiring(page = 1) {
    return HomeModel.getAiringAnime(page);
}

/**
 * Get detailed information about an anime.
 * @param {string} animeId - The AnimePahe session ID (e.g., "boruto-naruto-next-generations")
 * @returns {Promise<object>} - Anime details
 */
async function getInfo(animeId) {
    return AnimeInfoModel.getAnimeInfo(animeId);
}

/**
 * Get episode releases for an anime.
 * @param {string} animeId - The AnimePahe session ID
 * @param {string} [sort='episode_desc'] - Sort order
 * @param {number} [page=1] - Page number
 * @returns {Promise<object>} - Episode list
 */
async function getReleases(animeId, sort = 'episode_desc', page = 1) {
    return AnimeInfoModel.getAnimeReleases(animeId, sort, page);
}

/**
 * Get streaming links for a specific episode.
 * This is the core function for video extraction.
 * @param {string} animeId - The AnimePahe session ID
 * @param {string} episodeId - The episode session ID
 * @param {boolean} [includeDownloads=true] - Whether to include download links
 * @returns {Promise<object>} - Streaming sources with m3u8 URLs
 */
async function getStreamingLinks(animeId, episodeId, includeDownloads = true) {
    return PlayModel.getStreamingLinks(animeId, episodeId, includeDownloads);
}

/**
 * Get direct download link from a pahewin URL.
 * @param {string} url - The pahewin download page URL
 * @returns {Promise<object>} - Direct download URL
 */
async function getDownloadLink(url) {
    return PlayModel.getDownloadLinks(url);
}

/**
 * Get the anime list (A-Z index).
 * @param {string} [tab] - Filter by first letter (e.g., 'A', 'B', '#')
 * @param {string} [tag1] - Optional genre/tag filter
 * @param {string} [tag2] - Optional second tag filter
 * @returns {Promise<object>} - Anime list
 */
async function getAnimeList(tab, tag1, tag2) {
    return AnimeListModel.getAnimeList(tab, tag1, tag2);
}

/**
 * Get the queue (upcoming releases).
 * @returns {Promise<object>} - Queue data
 */
async function getQueue() {
    return QueueModel.getQueue();
}

// Export everything
module.exports = {
    // High-level API (Recommended)
    initialize,
    search,
    getAiring,
    getInfo,
    getReleases,
    getStreamingLinks,
    getDownloadLink,
    getAnimeList,
    getQueue,
    
    // Low-level access (Advanced)
    Animepahe,        // Raw scraper singleton
    Config,           // Configuration utility
    
    // Models (for direct access if needed)
    models: {
        HomeModel,
        AnimeInfoModel,
        AnimeListModel,
        PlayModel,
        QueueModel
    }
};
