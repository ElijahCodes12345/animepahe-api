const DataProcessor = require('../utils/dataProcessor');
const Config = require('../utils/config');
const Animepahe = require('../scrapers/animepahe');
const { CustomError } = require('../middleware/errorHandler');

class HomeModel {
    static async getAiringAnime(page) {
        const results = await Animepahe.getData("airing", { page });

        if (!results || !results.data) {
            throw new CustomError('No airing anime data found', 404);
        }

        return DataProcessor.processApiData(results);
    }

    static async searchAnime(query, page) {
        console.log(page);
        if (!query) {
            throw new CustomError('Search query is required', 400);
        }

        const results = await Animepahe.getData("search", { query, page });

        if (!results || !results.data) {
            throw new CustomError('No search results found', 404);
        }

        return DataProcessor.processApiData(results, 'search');
    }
}

module.exports = HomeModel;