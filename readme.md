# AnimepaheAPI

An unofficial REST API for [Animepahe](https://animepahe.ru/) that provides access to anime information, episodes, and streaming links.

## Features

- 🎯 Get currently airing anime
- 🔍 Search for specific anime
- 📋 Browse complete anime list
- 📺 Get anime details and episodes
- 🎬 Get streaming links
- 📱 Check encoding queue status
- ⚡ Fast and reliable
- 🐋 Redis support for improved performance
- 🛡️ Built-in DDoS protection bypass
- 🔄 Automatic cookie management

## Installation

```bash
git clone https://github.com/ElijahCodes12345/animepahe-api.git
cd animepahe-api
npm install
npx playwright install
copy .env.example .env
```

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FElijahCodes12345%2Fanimepahe-api)
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/ElijahCodes12345/animepahe-api)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/animepahe-api?referralCode=EgKNlg)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ElijahCodes12345/animepahe-api)

## Configuration

It works as it is but if you want you can create a `.env` file in the root directory:

```env
PORT=3000 # Optional
BASE_URL=https://animepahe.ru # Optional
USER_AGENT=  # Optional
COOKIES=     # Optional - for manual cookie management
USE_PROXY=false
PROXIES=     # Optional - comma-separated proxy URLs
REDIS_URL=   # Optional - Redis connection URL for caching (e.g., redis://user:pass@host:port)
```

### Redis Caching

The API supports Redis caching to improve performance and reduce load on the Animepahe servers. When `REDIS_URL` is provided, responses will be cached with the following durations:

- Queue status: 30 seconds
- Anime list: 1 hour
- Anime info: 1 day
- Play/stream info: 5 hours

You may edit these values as you see fit.

If `REDIS_URL` is not provided, the API will still work

## API Endpoints

### Airing Anime
```
GET /api/airing
GET /api/airing?page=2
```

### Search Anime
```
GET /api/search?q=your_search_query
GET /api/search?q=your_search_query&page=2
```

### Anime List
```
GET /api/anime
GET /api/anime?tab=A
GET /api/anime/:tag1/:tag2
GET /api/anime/:tag1/:tag2?tab=D
```
tag1 being eg: genre, Theme, etc. tag2 being eg: action, adventure, historical etc.
Note: For tab use 'hash' instead of '#'

### Anime Information
```
GET /api/:session            # Get anime details using anime session ID
GET /api/:session/releases?sort=episode_desc&page=1  # Get episode list
```

### Streaming
```
GET /api/play/:session?episodeId=example  # Get streaming links
```

> **Note:** In the API:
> - `:session` in the URL path is the anime's unique identifier (e.g., '758e3b17-8f49-47d2-ac3f-5f70a5656241')
> - `episodeId` as a query parameter is the episode's unique identifier, which matches the session value shown in individual episode entries from the /releases endpoint..
> 
> Example:
> ```
> /api/515dd441-386a-2ba3-6f79-e6e1e9c09802        # Get anime info
> /api/play/515dd441-386a-2ba3-6f79-e6e1e9c09802?episodeId=a6399696d987035b4063a625d57266525fad3c3ee576a6606dba33ee8ac08367  # Get episode stream
> ```

### Queue Status
```
GET /api/queue
```

## Error Handling

The API returns errors in this format:

```json
{
  "status": 503,
  "message": "Request failed"
}
```

## Technologies Used

- Node.js
- Express
- Playwright
- @sparticuz/chromium
- Cheerio
- Axios
- cloudscraper
- jsdom
- vm

## License

This project is licensed under the MIT License.

## Disclaimer

This project is not affiliated with or endorsed by Animepahe. It's an unofficial API created for educational purposes.

## Support

If you find this project helpful, please give it a ⭐️ on GitHub!