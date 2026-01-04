const path = require('path');

class UrlConverter {
    /**
     * Converts a stream m3u8 URL to a direct MP4 download URL
     * Input: https://exampledomain.top/stream/14/04/{hash}/uwu.m3u8
     * Output: https://anotherexampledomain.cx/mp4/14/04/{hash}
     * 
     * @param {string} m3u8Url - The original stream URL   
     * @param {string} kwikDomain - The kwik domain (e.g. 'kwik.cx')
     * @returns {string|null} - The converted download URL or null if invalid
     */
    static getMp4Url(m3u8Url, kwikDomain) {
        if (!m3u8Url || !m3u8Url.includes('/stream/')) return null;
        
        try {
            const urlObj = new URL(m3u8Url);
            
            const hostParts = urlObj.hostname.split('.');
            if (hostParts[0].startsWith('vault-')) {
                urlObj.hostname = `${hostParts[0]}.${kwikDomain}`;
            } else {
                urlObj.hostname = kwikDomain;
            }
            
            urlObj.pathname = urlObj.pathname.replace('/stream/', '/mp4/');
            
            if (urlObj.pathname.endsWith('/uwu.m3u8')) {
                urlObj.pathname = urlObj.pathname.replace('/uwu.m3u8', '');
            } else if (urlObj.pathname.endsWith('.m3u8')) {
                urlObj.pathname = urlObj.pathname.replace('.m3u8', '');
            }
            
            return urlObj.toString();
        } catch (e) {
            console.error('Error converting stream URL:', e);
            return null;
        }
    }

    /**
     * Generates a descriptive filename for the download
     * Format: AnimePahe_{Anime_Title}_{Eng_Dub?}_-_{Episode}_{BD?}_{Resolution}_{Fansub}.mp4
     */
    static getFilename(animeTitle, episode, resolution, fansub, isDub, isBD) {
        if (!animeTitle) return 'video.mp4';
        
        // Sanitize title
        const safeTitle = animeTitle.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
        const dubStr = isDub ? '_Eng_Dub' : '';
        const bdStr = isBD ? '_BD' : '';
        const resStr = resolution ? `_${resolution}p` : '';
        const fansubStr = fansub ? `_${fansub}` : '';
        const epStr = episode || '0';
        
        return `AnimePahe_${safeTitle}${dubStr}_-_${epStr}${bdStr}${resStr}${fansubStr}.mp4`;
    }

    /**
     * Builds the full download URL with filename parameter
     */
    static buildDownloadUrl(m3u8Url, kwikDomain, metadata) {
        const mp4Url = this.getMp4Url(m3u8Url, kwikDomain);
        if (!mp4Url) return null;
        
        const filename = this.getFilename(
            metadata.animeTitle,
            metadata.episode,
            metadata.resolution,
            metadata.fansub,
            metadata.isDub,
            metadata.isBD
        );
        
        return `${mp4Url}?file=${filename}`;
    }
}

module.exports = UrlConverter;
