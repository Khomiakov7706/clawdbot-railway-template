# scrum-service — standalone Railway service (root directory: services/scrum-service)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
# No lockfile committed yet; generate one at build time. Switch to `npm ci` once
# package-lock.json is checked in.
RUN npm install --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Railway injects PORT at runtime; do not hardcode it.
CMD ["node", "src/server.mjs"]
