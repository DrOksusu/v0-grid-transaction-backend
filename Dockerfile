# Build stage
FROM node:18-alpine AS builder

# 캐시 무효화를 위한 빌드 인자
ARG BUILD_DATE=unknown
ARG COMMIT_SHA=unknown
RUN echo "Build: $BUILD_DATE - $COMMIT_SHA"

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma-stablecoin ./prisma-stablecoin/

# Install dependencies
RUN npm ci

# Generate Prisma clients (main + stablecoin)
RUN npx prisma generate && npx prisma generate --schema=prisma-stablecoin/schema.prisma

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma-stablecoin ./prisma-stablecoin/


# Install production dependencies only
RUN npm ci --omit=dev

# Copy generated Prisma clients from builder (main + stablecoin)
# node_modules/.prisma/ 아래에 client/ 와 client-stablecoin/ 모두 포함됨
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3010/api/health || exit 1

# Start the application (dual migrate deploy 후 서버 시작)
# 1) main 스키마: DATABASE_URL=grid_migrate로 임시 override → migrate
# 2) stablecoin 스키마: STABLECOIN_DATABASE_URL=grid_stablecoin_migrate로 임시 override → migrate
# 3) node 실행: 원래 env (DATABASE_URL=grid_app, STABLECOIN_DATABASE_URL=grid_stablecoin_app)로 복귀
CMD ["sh", "-c", "DATABASE_URL=\"$MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma/schema.prisma && STABLECOIN_DATABASE_URL=\"$STABLECOIN_MIGRATE_DATABASE_URL\" npx prisma migrate deploy --schema=prisma-stablecoin/schema.prisma && node dist/index.js"]
