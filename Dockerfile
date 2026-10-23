# Aerwell API container image (ECS Fargate, ARM64). Same shape as alfred-api/Dockerfile.
# Build stage: full install, compile TypeScript.
FROM public.ecr.aws/docker/library/node:22-alpine AS builder

WORKDIR /app
# mongodb-memory-server (devDependency) downloads a mongod binary on install; no tests run here.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage: production dependencies and compiled output only. One-off scripts run
# as `node dist/scripts/*.js` (no tsx, no src).
FROM public.ecr.aws/docker/library/node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3003
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY scripts ./scripts
RUN chmod 755 /app/scripts/container-entrypoint.sh

USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3003/api/v1/health/live || exit 1

ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
CMD ["node", "dist/index.js"]
