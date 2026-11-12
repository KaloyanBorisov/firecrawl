# Playwright Scrape API

This is a simple web scraping service built with Express and Playwright.

## Features

- Scrapes HTML content from specified URLs.
- Blocks requests to known ad-serving domains.
- Blocks media files to reduce bandwidth usage.
- Uses random user-agent strings to avoid detection.
- Strategy to ensure the page is fully rendered.

## Install
```bash
npm install
npx playwright install
```

## RUN
```bash
npm run build
npm start
```
OR
```bash
npm run dev
```

## USE

```bash
curl -X POST http://localhost:3000/scrape \
-H "Content-Type: application/json" \
-d '{
  "url": "https://example.com",
  "wait_after_load": 1000,
  "timeout": 15000,
  "headers": {
    "Custom-Header": "value"
  },
  "check_selector": "#content"
}'
```

## USING WITH FIRECRAWL

Add `PLAYWRIGHT_MICROSERVICE_URL=http://localhost:3003/scrape` to `/apps/api/.env` to configure the API to use this Playwright microservice for scraping operations.

## Persistent login profiles (self-host)

Send `profile: { name, saveChanges }` with a v2 scrape and the service loads
`${PROFILES_DIR:-/data/profiles}/<name>.json` (Playwright `storageState`) into the
browser context. After a successful scrape (HTTP 200, not landed on a
login/sign-in URL) and unless `saveChanges: false`, the refreshed cookies and
localStorage are written back (mode 600, atomic rename). A missing profile
starts empty, so it behaves like an anonymous scrape. A `Cookie` header, if sent
too, is applied on top of the profile.

- Names must match `^[a-z0-9._-]{1,64}$`. Use one profile per site, and do not store banks, brokerages or email.
- `docker-compose.yaml` mounts the `playwright_profiles` volume on this service only.
- Profile contents are login tokens. They are never logged, and `Cookie`/`Authorization` header values are redacted in the request log.

Seeding a profile from a Chrome cookie export (writes straight into the volume):

```bash
python3 scripts/cookies_to_storage_state.py --name stocktwits \
  --volume firecrawl_playwright_profiles stocktwits.com_cookies.json
```

Alternatively, log in by hand once and copy the saved state into the volume:

```bash
npx playwright open --save-storage=stocktwits.json https://stocktwits.com/signin
docker run -i --rm -v firecrawl_playwright_profiles:/p busybox:1.36 \
  sh -c 'cat > /p/stocktwits.json && chown 1000:1000 /p/stocktwits.json && chmod 600 /p/stocktwits.json' < stocktwits.json
rm stocktwits.json
```
