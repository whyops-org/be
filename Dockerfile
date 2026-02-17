# WhyOps Unified Dockerfile
# Usage: docker build --build-arg SERVICE=proxy .
# Valid SERVICE values: proxy, analyse, auth

ARG SERVICE=proxy
FROM oven/bun:1.1-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lockb ./
COPY shared/package.json ./shared/
RUN bun install --frozen-lockfile

# Build stage - builds all services (faster for multi-service deploys)
FROM base AS build
ARG SERVICE
COPY --from=install /app/node_modules ./node_modules
COPY shared ./shared
COPY whyops-proxy ./whyops-proxy
COPY whyops-analyse ./whyops-analyse
COPY whyops-auth ./whyops-auth
COPY package.json tsconfig.json ./

RUN bun run build:proxy && \
    bun run build:analyse && \
    bun run build:auth

# Production stage - select service based on build arg
FROM base AS production
ARG SERVICE
ENV NODE_ENV=production
ENV SERVICE=${SERVICE}

COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/whyops-proxy ./whyops-proxy
COPY --from=build /app/whyops-analyse ./whyops-analyse
COPY --from=build /app/whyops-auth ./whyops-auth
COPY package.json ./

# Default to proxy if not specified
EXPOSE 8080 8081 8082

# CMD selects the service based on SERVICE arg
CMD ["sh", "-c", "bun run whyops-${SERVICE:-proxy}/src/index.ts"]
