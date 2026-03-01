# WhyOps Unified Dockerfile
# Usage (required): docker build --build-arg SERVICE=proxy .
# Valid SERVICE values: proxy, analyse, auth

ARG SERVICE
FROM oven/bun:1.3-alpine AS base
WORKDIR /app

# Install and build in single stage to preserve workspace symlinks
FROM base AS builder
ARG SERVICE
RUN case "$SERVICE" in \
      proxy|analyse|auth) ;; \
      *) echo "Invalid SERVICE: $SERVICE (expected proxy|analyse|auth)" >&2; exit 1 ;; \
    esac

COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY whyops-proxy/package.json ./whyops-proxy/
COPY whyops-analyse/package.json ./whyops-analyse/
COPY whyops-auth/package.json ./whyops-auth/
RUN bun install --frozen-lockfile

COPY shared ./shared
COPY whyops-${SERVICE} ./whyops-${SERVICE}
COPY tsconfig.json ./

RUN bun run build:shared && \
    bun run build:${SERVICE}

# Production stage - select service based on build arg
FROM base AS production
ARG SERVICE
# Runtime defaults for non-secret configuration.
# All secrets and environment-specific values should still be injected by the deploy platform.
ENV NODE_ENV=production \
    SERVICE=${SERVICE} \
    LOG_LEVEL=info \
    PROXY_PORT=8080 \
    ANALYSE_PORT=8081 \
    AUTH_PORT=8082 \
    API_KEY_PREFIX=whyops \
    RATE_LIMIT_WINDOW_MS=60000 \
    RATE_LIMIT_MAX_REQUESTS=100 \
    PROXY_TIMEOUT_MS=60000 \
    PROXY_MAX_RETRIES=3 \
    REDIS_KEY_PREFIX=whyops \
    EVENTS_STREAM_NAME=whyops:events \
    EVENTS_DLQ_STREAM_NAME=whyops:events:dlq \
    EVENTS_STREAM_GROUP=whyops-analyse-workers \
    EVENTS_STREAM_MAX_LEN=200000 \
    EVENTS_STREAM_BATCH_SIZE=100 \
    EVENTS_STREAM_BLOCK_MS=2000 \
    EVENTS_STREAM_RETRY_MAX=5 \
    EVENTS_WORKER_ENABLED=true \
    AUTH_APIKEY_CACHE_TTL_SEC=60 \
    PROVIDER_CACHE_TTL_SEC=60 \
    APIKEY_LAST_USED_WRITE_INTERVAL_SEC=300 \
    JUDGE_LLM_BASE_URL=https://litellm.whiteocean-2fb73b80.centralindia.azurecontainerapps.io/v1 \
    JUDGE_LLM_MODEL=azure/gpt-4.1 \
    JUDGE_LLM_TEMPERATURE=0 \
    JUDGE_MAX_RETRIES=2 \
    DB_SSL=true \
    DB_SSL_REJECT_UNAUTHORIZED=false

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/whyops-${SERVICE} ./whyops-${SERVICE}

# Service ports (proxy 8080, analyse 8081, auth 8082)
EXPOSE 8080 8081 8082

# CMD selects the service based on SERVICE arg
WORKDIR /app/whyops-${SERVICE}
CMD ["bun", "run", "start"]
