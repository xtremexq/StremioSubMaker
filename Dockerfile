# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Create cache directories and keys directory for encryption key persistence
RUN mkdir -p .cache/translations \
    .cache/translations_bypass \
    .cache/translations_partial \
    .cache/sync_cache \
    data \
    logs \
    keys

# Set permissions: node owns everything, data dirs are world-writable (777)
# so containers running with arbitrary UIDs (user: PUID:PGID) can write to them.
# For bind mounts, host-side permissions still apply — the entrypoint checks those.
RUN chown -R node:node /app && \
    chmod 777 .cache data logs keys

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Use non-root user (override with `user:` in docker-compose for custom UID)
USER node

# Expose port (default 7001)
EXPOSE 7001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Entrypoint validates directories/permissions before starting the app
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
