# Docker Deployment Guide

You can run SubMaker directly from Docker Hub without cloning the repo. Below are copy-paste compose files, minimal `.env` examples, and optional build/run instructions for source checkouts.

## Prerequisites
- Docker 20+ and Docker Compose v2
- An OpenSubtitles API key (required)

## Quick Start (Docker Hub image + Redis)

1) Create a folder and enter it:
```bash
mkdir stremio-submaker && cd stremio-submaker
```

2) Create `.env` (minimum settings):
```env
OPENSUBTITLES_API_KEY=your_opensubtitles_key
STORAGE_TYPE=redis
# Optional: override defaults
# PORT=7001
# REDIS_HOST=redis
# REDIS_PORT=6379
# REDIS_PASSWORD=
# REDIS_DB=0
# REDIS_KEY_PREFIX=stremio
```

3) Create `docker-compose.yaml` (uses Docker Hub image):
```yaml
version: "3.9"

services:
  submaker:
    image: xtremexq/submaker:latest
    container_name: submaker
    ports:
      - "${PORT:-7001}:7001"
    env_file:
      - .env
    environment:
      - STORAGE_TYPE=redis
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD:-}
      - REDIS_DB=0
      - REDIS_KEY_PREFIX=stremio
      - ENCRYPTION_KEY_FILE=/app/keys/.encryption-key
      - REDIS_PASSWORD_FILE=/app/keys/.redis-password
      - TRUST_PROXY=1
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - stremio-network
    volumes:
      - app-data:/app/data
      - app-cache:/app/.cache
      - app-logs:/app/logs
      - encryption-key:/app/keys

  redis:
    image: redis:7-alpine
    container_name: stremio-redis
    command: >
      redis-server
      --maxmemory 4gb
      --maxmemory-policy allkeys-lru
      --save 900 1
      --save 300 10
      --save 60 10000
      --appendonly yes
      --appendfsync everysec
      --no-appendfsync-on-rewrite no
      --timeout 300
      --tcp-keepalive 60
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    networks:
      - stremio-network

networks:
  stremio-network:
    driver: bridge

volumes:
  redis-data:
  app-data:
  app-cache:
  app-logs:
  encryption-key:
```

4) Start and watch logs:
```bash
docker-compose up -d
docker-compose logs -f submaker
```

## Filesystem-only variant (no Redis)

Good for single-node/local use. Storage stays on local disk.

`.env`:
```env
OPENSUBTITLES_API_KEY=your_opensubtitles_key
STORAGE_TYPE=filesystem
# PORT=7001
```

`docker-compose.yaml`:
```yaml
version: "3.9"

services:
  submaker:
    image: xtremexq/submaker:latest
    container_name: submaker
    ports:
      - "${PORT:-7001}:7001"
    env_file:
      - .env
    environment:
      - STORAGE_TYPE=filesystem
      - ENCRYPTION_KEY_FILE=/app/keys/.encryption-key
      - TRUST_PROXY=1
    volumes:
      - ./data:/app/data
      - ./.cache:/app/.cache
      - ./logs:/app/logs
      - ./keys:/app/keys
    restart: unless-stopped
```

Start with:
```bash
docker-compose up -d
docker-compose logs -f submaker
```

## Using the repo (build or image)

If you clone the repo, `docker-compose.yaml` defaults to building locally. To use the Docker Hub image instead, comment out `build: .` and uncomment the `image:` line.

```bash
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker
cp .env.example .env
# edit .env with your keys
docker-compose up -d          # uses build
# or, after switching to image: ... in compose:
# docker-compose up -d
```

## Docker run (without Compose)

Filesystem storage:
```bash
docker run -d \
  --name submaker \
  -p 7001:7001 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/keys:/app/keys \
  -v $(pwd)/.cache:/app/.cache \
  -e STORAGE_TYPE=filesystem \
  -e OPENSUBTITLES_API_KEY=your_opensubtitles_key \
  xtremexq/submaker:latest
```

External Redis (you supply Redis):
```bash
docker run -d \
  --name submaker \
  -p 7001:7001 \
  -e STORAGE_TYPE=redis \
  -e REDIS_HOST=your-redis-host \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD= \
  -e REDIS_DB=0 \
  -e REDIS_KEY_PREFIX=stremio \
  -e REDIS_PASSWORD_FILE=/app/keys/.redis-password \
  -e ENCRYPTION_KEY_FILE=/app/keys/.encryption-key \
  -v $(pwd)/keys:/app/keys \
  xtremexq/submaker:latest
```

## Configuration notes
- `OPENSUBTITLES_API_KEY` is required.
- `STORAGE_TYPE` defaults to `redis`; set to `filesystem` for single-node/local installs.
- Encryption key: if `ENCRYPTION_KEY` is unset, the app writes a key to `/app/keys/.encryption-key`; keep that path persistent (named volume or bind mount).
- Redis password: set `REDIS_PASSWORD_FILE` (for example `/app/keys/.redis-password`) to auto-generate and persist a strong Redis password. If `REDIS_PASSWORD` is set, that value is used instead and written to the password file. Ensure Redis is configured to read the same file; the provided `docker-compose.yaml` handles this via the shared `keys` volume.
- Ports: container listens on `7001` by default; override with `PORT` env and matching host mapping.
- `TRUST_PROXY`: set to `1` when running behind a reverse proxy (nginx, Cloudflare, etc.) so Express reads the real client IP from `X-Forwarded-For`. Defaults to `false` (safe for direct exposure). Accepts numeric depth, boolean, or named values (`loopback`, `linklocal`, `uniquelocal`).

## Troubleshooting
- Check app logs: `docker-compose logs -f submaker`
- Check Redis: `docker-compose logs -f redis` and `docker-compose ps`
- Port in use? adjust `${PORT:-7001}` mapping or free the port (`lsof -i :7001` on Linux/macOS, `netstat -ano | findstr :7001` on Windows).
- Refresh image: `docker pull xtremexq/submaker:latest` then `docker-compose up -d`

---

[Back to README](../README.md)
