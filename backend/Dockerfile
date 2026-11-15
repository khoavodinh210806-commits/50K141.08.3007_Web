FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.build.json ./
COPY src/inventory ./src/inventory
COPY src/server.ts ./src/server.ts
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/build ./build
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY sql/postgres/001_init.sql ./sql/postgres/001_init.sql
USER node
EXPOSE 4000
CMD ["node", "build/server.js"]
