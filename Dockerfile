# syntax=docker/dockerfile:1.6

# ---------- Stage 1: build the React (Vite) dashboard ----------
FROM node:20-alpine AS dashboard-build
WORKDIR /app/dashboard

# Install deps from clean lockfile if present, else fall back to install
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY dashboard/ ./
RUN npm run build


# ---------- Stage 2: install production node_modules for the server ----------
FROM node:20-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi


# ---------- Stage 3: runtime image ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=8080
ENV HOST=0.0.0.0

# Server source + production deps
COPY --from=server-deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js server.js ./
COPY src ./src
COPY server ./server

# Built dashboard (served by Express in production)
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

# Drop privileges
USER node

EXPOSE 8080
CMD ["node", "server.js"]
