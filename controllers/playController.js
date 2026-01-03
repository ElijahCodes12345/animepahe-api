const PlayModel = require('../models/playModel');
const { CustomError } = require('../middleware/errorHandler');

class PlayController {
    static async getStreamingLinks(req, res, next) {
        try {
            const { id } = req.params;
            const { episodeId, downloads } = req.query;

            if (!id || !episodeId) {
                throw new CustomError('Both id and episodeId are required', 400);
            }

            // Parse downloads query parameter (defaults to true)
            // user can pass ?downloads=false or ?downloads=0 to skip downloads
            const includeDownloads = downloads === undefined || downloads === 'true' || downloads === '1';

            // console.log(`[PlayController] Request query downloads: '${downloads}' -> includeDownloads: ${includeDownloads}`);

            const links = await PlayModel.getStreamingLinks(id, episodeId, includeDownloads);
            
            return res.json(links);
        } catch (error) {
            next(error);
        }
    }

    static async getDownloadLinks(req, res, next) {
        try {
            const { url } = req.query;

            if (!url) {
                throw new CustomError('Url is required', 400);
            }

            const links = await PlayModel.getDownloadLinks(url);
            return res.json(links);
        } catch (error) {
            next(error);
        }
    }
}

module.exports = PlayController;