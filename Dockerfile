FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# 2. Install dependencies
COPY package.json bun.lockb* ./
# Use --frozen-lockfile for deterministic installs in CI/CD
RUN bun install --frozen-lockfile

# 3. Copy application code
COPY . .

RUN bun run build

FROM oven/bun:1 AS production
WORKDIR /usr/src/app

# Copy installed dependencies and built code from the base image
COPY --from=base /usr/src/app/node_modules ./node_modules
COPY --from=base /usr/src/app/dist ./dist
COPY --from=base /usr/src/app/package.json ./package.json

# Copy Drizzle migration files if needed for runtime migrations
# COPY --from=base /usr/src/app/drizzle ./drizzle

ENV NODE_ENV=production

EXPOSE 6000

CMD ["bun", "run", "start"]
