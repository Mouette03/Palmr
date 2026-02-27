FROM node:24-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
  gcompat \
  supervisor \
  curl \
  wget \
  openssl \
  su-exec

# Enable pnpm
RUN corepack enable pnpm

# Set working directory
WORKDIR /app

# === SERVER BUILD STAGE ===
FROM base AS server-deps
WORKDIR /app/server

# Copy server package files
COPY apps/server/package*.json ./
COPY apps/server/pnpm-lock.yaml ./

# Install server dependencies
RUN pnpm install --frozen-lockfile

FROM base AS server-builder
WORKDIR /app/server

# Copy server dependencies
COPY --from=server-deps /app/server/node_modules ./node_modules

# Copy server source code
COPY apps/server/ ./

# Generate Prisma client
RUN npx prisma generate

# Build server
RUN pnpm build

# === WEB BUILD STAGE ===
FROM base AS web-deps
WORKDIR /app/web

# Copy web package files
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./

# Install web dependencies
RUN pnpm install --frozen-lockfile

FROM base AS web-builder
WORKDIR /app/web

# Copy web dependencies
COPY --from=web-deps /app/web/node_modules ./node_modules

# Copy web source code
COPY apps/web/ ./

# Set environment variables for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build web application
RUN pnpm run build

# === PRODUCTION STAGE ===
FROM base AS runner

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV API_BASE_URL=http://127.0.0.1:3333

# Define build arguments for user/group configuration (defaults to current values)
ARG PALMR_UID=1001
ARG PALMR_GID=1001

# Create application user with configurable UID/GID
RUN addgroup --system --gid ${PALMR_GID} nodejs
RUN adduser --system --uid ${PALMR_UID} --ingroup nodejs palmr

# Create application directories 
RUN mkdir -p /app/palmr-app /app/web /app/infra /home/palmr/.npm /home/palmr/.cache
RUN chown -R palmr:nodejs /app /home/palmr

# === Copy Server Files to /app/palmr-app (separate from /app/server for bind mounts) ===
WORKDIR /app/palmr-app

# Copy server production files
COPY --from=server-builder --chown=palmr:nodejs /app/server/dist ./dist
COPY --from=server-builder --chown=palmr:nodejs /app/server/node_modules ./node_modules
COPY --from=server-builder --chown=palmr:nodejs /app/server/prisma ./prisma
COPY --from=server-builder --chown=palmr:nodejs /app/server/package.json ./

# Copy password reset script and make it executable
COPY --from=server-builder --chown=palmr:nodejs /app/server/reset-password.sh ./
COPY --from=server-builder --chown=palmr:nodejs /app/server/src/scripts/ ./src/scripts/
RUN chmod +x ./reset-password.sh

# Copy seed file to the shared location for bind mounts
RUN mkdir -p /app/server/prisma
COPY --from=server-builder --chown=palmr:nodejs /app/server/prisma/seed.js /app/server/prisma/seed.js

# === Copy Web Files ===
WORKDIR /app/web

# Copy web production files
COPY --from=web-builder --chown=palmr:nodejs /app/web/public ./public
COPY --from=web-builder --chown=palmr:nodejs /app/web/.next/standalone ./
COPY --from=web-builder --chown=palmr:nodejs /app/web/.next/static ./.next/static

# === Setup Supervisor ===
WORKDIR /app

# Create supervisor configuration
RUN mkdir -p /etc/supervisor/conf.d

# Copy server start script and configuration files
COPY infra/server-start.sh /app/server-start.sh
COPY infra/configs.json /app/infra/configs.json
COPY infra/providers.json /app/infra/providers.json
COPY infra/check-missing.js /app/infra/check-missing.js
RUN chmod +x /app/server-start.sh
RUN chown -R palmr:nodejs /app/server-start.sh /app/infra

# Copy supervisor configuration
COPY infra/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Create main startup script
COPY <<EOF /app/start.sh
#!/bin/sh
set -e

echo "Starting Palmr Application..."
echo "Storage Mode: Local filesystem"
echo "Secure Site: \${SECURE_SITE:-false}"
echo "Database: SQLite"

# Set global environment variables
export DATABASE_URL="file:/app/server/prisma/palmr.db"
export NEXT_PUBLIC_DEFAULT_LANGUAGE=\${DEFAULT_LANGUAGE:-en-US}

# Ensure /app/server directory structure exists
mkdir -p /app/server/uploads /app/server/temp-uploads /app/server/prisma

# USE ENVIRONMENT VARIABLES: Allow runtime UID/GID configuration
TARGET_UID=\${PALMR_UID:-\$(id -u palmr 2>/dev/null || echo "1001")}
TARGET_GID=\${PALMR_GID:-\$(id -g palmr 2>/dev/null || echo "1001")}
echo "   Target user: palmr (UID:\$TARGET_UID, GID:\$TARGET_GID)"

# SMART CHOWN: Only run expensive recursive chown when UID/GID changed
UIDGID_MARKER="/app/server/.palmr-uidgid"
CURRENT_OWNER="\$TARGET_UID:\$TARGET_GID"
NEEDS_CHOWN=false

if [ -f "\$UIDGID_MARKER" ]; then
    STORED_OWNER=\$(cat "\$UIDGID_MARKER" 2>/dev/null || echo "")
    if [ "\$STORED_OWNER" != "\$CURRENT_OWNER" ]; then
        echo "   UID/GID changed (\$STORED_OWNER → \$CURRENT_OWNER)"
        NEEDS_CHOWN=true
    else
        echo "   ✓ UID/GID unchanged (\$CURRENT_OWNER), skipping chown"
    fi
else
    echo "   First run or marker missing, will set ownership"
    NEEDS_CHOWN=true
fi

if [ "\$NEEDS_CHOWN" = "true" ]; then
    echo "   Setting ownership..."
    chown \$TARGET_UID:\$TARGET_GID /app/server 2>/dev/null || true
    for dir in uploads temp-uploads; do
        if [ -d "/app/server/\$dir" ]; then
            chown -R \$TARGET_UID:\$TARGET_GID "/app/server/\$dir" 2>/dev/null || true
        fi
    done
    if [ -d "/app/server/prisma" ]; then
        chown -R \$TARGET_UID:\$TARGET_GID "/app/server/prisma" 2>/dev/null || true
    fi
    echo "\$CURRENT_OWNER" > "\$UIDGID_MARKER"
    chown \$TARGET_UID:\$TARGET_GID "\$UIDGID_MARKER" 2>/dev/null || true
    echo "   ✅ Ownership updated"
fi

# Verify storage directory is writable
if touch /app/server/.test-write 2>/dev/null; then
    rm -f /app/server/.test-write
    echo "   ✅ Storage directory is writable"
else
    echo "   ❌ FATAL: /app/server is NOT writable!"
    ls -la /app/server 2>/dev/null || true
fi

echo "✅ Storage ready, starting services..."

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
EOF

RUN chmod +x /app/start.sh

# Create volume mount points for bind mounts
VOLUME ["/app/server"]

# Expose ports
EXPOSE 3333 5487

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:5487 || exit 1

# Start application
CMD ["/app/start.sh"]