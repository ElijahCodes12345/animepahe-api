const Config = require('./config');

class DataProcessor {
    static processApiData(apiData, type = 'airing', include = true) {

        const items = apiData.data || [];
        
        if (!Array.isArray(items)) {
            console.error('Unexpected API response format:', JSON.stringify(apiData).substring(0, 200));
            throw new Error('Unexpected API response format');
        }

        let paginationInfo;
        include ? paginationInfo = this._extractPaginationInfo(apiData, type) : paginationInfo;

        const dataProcessors = {
            'airing': this._processAiringData,
            'search': this._processSearchData,
            'releases': this._processReleaseData,
            'queue': this._processQueueData,
        };
        
        if (type === 'releases') items._parentId = apiData._id;

        const processor = dataProcessors[type] || this._processGenericData;
        
        const processedData = processor(items);
        
        if (processedData.length > 0) {
            console.log(`Processed ${processedData.length} items of type: ${type}`);
            // console.log("Sample:", processedData[0]);
        }
        
        return paginationInfo ? { paginationInfo, data: processedData } : { data: processedData };
    }
    
    static _extractPaginationInfo(apiData, type) {
        const {
            _id, 
            total, per_page, current_page, last_page, 
            next_page_url, prev_page_url, from, to 
        } = apiData;

        const urlPrefix = _id ? `${_id}/${type}?` : `${type}?`;

        return {
            ...(total != null && { total }),
            ...(per_page != null && { perPage: per_page }),
            ...(current_page != null && { currentPage: current_page }),
            ...(last_page != null && { lastPage: last_page }),
            ...(next_page_url != null && { 
                nextPageUrl: next_page_url.replace(
                    new RegExp(`^(${Config.baseUrl}|/)`),
                    Config.hostUrl
                ).replace('api?', `api/${urlPrefix}`)
            }),
            ...(prev_page_url != null && { 
                prevPageUrl: prev_page_url.replace(
                    new RegExp(`^(${Config.baseUrl}|/)`),
                    Config.hostUrl
                ).replace('api?', `api/${urlPrefix}`)  
            }),
            ...(from != null && { from }),
            ...(to != null && { to })
        };
    }

    static _processAiringData(items) {
        return items.map(item => ({
            id: item.id || null,
            anime_id: item.anime_id || null,
            title: item.anime_title || null,
            episode: item.episode || null,
            episode2: item.episode2 || null,
            edition: item.edition || null,
            fansub: item.fansub || null,
            image: item.snapshot || null,
            disc: item.disc || null,
            session: item.anime_session || null,
            link: (item.session ? `${Config.getUrl('animeInfo', item.session)}` : '') || null,
            filler: item.filler || null,
            created_at: item.created_at || null,
            completed: item.completed || 1
        }));
    }
    
    static _processSearchData(items) {
        return items.map(item => ({
            id: item.id || null,
            title: item.title || null,
            status: item.status || null,
            type: item.type || null,
            episodes: item.episodes || null,
            score: item.score || null,
            year: item.year || null,
            season: item.season || null,
            poster: item.poster || null,
            session: item.session || null,
            link: (item.session ? `${Config.getUrl('animeInfo', item.session)}` : '') || null,
        }));
    }

    static _processReleaseData(items) {
        return items.map(item => ({
            id: item.id || null,
            anime_id: item.anime_id || null,
            episode: item.episode || null,
            episode2: item.episode2 || null,
            edition: item.edition || null,
            title: item.title || null,
            snapshot: item.snapshot || null,
            disc: item.disc || null,
            audio: item.audio || null,
            duration: item.duration || null,
            session: item.session || null,
            link: (item.session ? `${Config.getUrl('play', items._parentId, item.session)}` : '') || null,
            filler: item.filler || null,
            created_at: item.created_at || null
        }))
    }
    
    static _processQueueData(items) {
        return items.map(item => ({
            title: item.title || null,
            episode: item.episode || null,
            resolution: item.resolution || null,
            filesize: item.filesize || null,
            fansub: item.fansub || null,
            audio: item.audio || null,
            progress: item.progress || null,
            instant: item.instant || null,
            current_duration: item.current_duration || null,
            original: item.original_duration || null,
            session: item.session || null,
            published: item.published || null,
        }));
    }
    
    // For unknown data types 
    static _processGenericData(items) {
        return items.map(item => {
            // Clone the item but ensure no null property values
            const processed = {};
            Object.keys(item).forEach(key => {
                processed[key] = item[key] || null;
            });
            return processed;
        });
    }
}

module.exports = DataProcessor;