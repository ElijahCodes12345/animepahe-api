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
- 🛡️ Built-in DDoS protection bypass
- 🔄 Automatic cookie management
- 🌐 Proxy support for enhanced reliability
- 🔒 Configurable through environment variables

## Installation

```bash
# Clone the repository
git clone https://github.com/ElijahCodes12345/animepahe-api.git

# Navigate to project directory
cd animepahe-api

# Install dependencies
npm install

# Install Playwright browsers (required for scraping and cookies auto-refresh)
npx playwright install

# Create .env file from example
copy .env.example .env  # On Windows
# cp .env.example .env  # On Unix-based systems
```

## Configuration

While not compulsory cause it comes with default values already (except for adding proxies)..
You can Create a `.env` file in the root directory that will override the default, possible variables are:

```env
# Base configuration
PORT=3000
BASE_URL=https://animepahe.com
USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36

# Cookie configuration
COOKIES=your_cookies_here    # Optional: Cookies for authenticated requests

# Proxy configuration
USE_PROXY=false             # Set to 'true' to enable proxy support
PROXIES=http://proxy1.com,http://proxy2.com    # Comma-separated list of proxy servers
```

### Cookie Format
The `COOKIES` variable should be in standard cookie header format:
```
cookie1=value1; cookie2=value2
```

### Proxy Format
The `PROXIES` variable should be a comma-separated list of proxy URLs:
```
http://proxy1.com:8080,http://user:pass@proxy2.com:8080
```

## Usage

```bash
# Start the server
npm start

# Development mode with auto-reload
npm run dev
```

The API will be available at `http://localhost:3000`

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
```

### Anime Information
```
GET /api/:id
GET /api/:id/releases?sort=episode_desc&page=1
```

### Streaming
```
GET /api/play/:id?episodeId=example
```

### Queue Status
```
GET /api/queue
```

## Response Examples

### Airing Anime Response
```json
{
  "paginationInfo": {
    "currentPage": 1,
    "lastPage": 10,
    "perPage": 30,
    "total": 300
  },
  "data": [
    {
      "id": "123",
      "title": "Example Anime",
      "episode": "1",
      "image": "https://example.com/image.jpg",
      "link": "https://example.com/anime/123"
    }
  ]
}
```

## Error Handling

The API uses standard HTTP status codes and returns errors in the following format:

```json
{
  "status": 404,
  "message": "Resource not found"
}
```

Common status codes:
- `400` - Bad Request
- `404` - Not Found
- `503` - Service Unavailable

## Technologies Used

- Node.js
- Express
- Playwright
- Cheerio
- Axios

## Development

The project structure:
```
animepahe-api/
├── controllers/    # Request handlers
├── models/        # Data models and business logic
├── routes/        # API route definitions
├── scrapers/      # Web scraping logic
├── utils/         # Helper utilities
├── middleware/    # Express middleware
└── app.js         # Application entry point
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This project is not affiliated with or endorsed by Animepahe. It's an unofficial API created for educational purposes.

## Support

If you find this project helpful, please give it a ⭐️ on GitHub!