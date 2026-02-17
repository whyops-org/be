# WhyOps Unified Dockerfile
# Usage (required): docker build --build-arg SERVICE=proxy .
# Valid SERVICE values: proxy, analyse, auth

ARG SERVICE
FROM oven/bun:1.1-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock ./
COPY shared/package.json ./shared/
COPY whyops-proxy/package.json ./whyops-proxy/
COPY whyops-analyse/package.json ./whyops-analyse/
COPY whyops-auth/package.json ./whyops-auth/
RUN bun install --frozen-lockfile

# Build stage - build only the selected service
FROM base AS build
ARG SERVICE
RUN case "$SERVICE" in \
      proxy|analyse|auth) ;; \
      *) echo "Invalid SERVICE: $SERVICE (expected proxy|analyse|auth)" >&2; exit 1 ;; \
    esac
COPY --from=install /app/node_modules ./node_modules
COPY shared ./shared
COPY whyops-${SERVICE} ./whyops-${SERVICE}
COPY package.json tsconfig.json ./

RUN bun run build:shared && \
    bun run build:${SERVICE}

# Production stage - select service based on build arg
FROM base AS production
ARG SERVICE
ENV NODE_ENV=production
ENV SERVICE=${SERVICE}

COPY --from=install /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/whyops-${SERVICE} ./whyops-${SERVICE}

# Service ports (proxy 8080, analyse 8081, auth 8082)
EXPOSE 8080 8081 8082

# CMD selects the service based on SERVICE arg
WORKDIR /app/whyops-${SERVICE}
CMD ["bun", "run", "start"]
