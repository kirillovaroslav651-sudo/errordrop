# Build frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build backend
FROM node:22-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Run API and Telegram bot
FROM node:22-alpine
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=backend-build /app/backend/node_modules ./backend/node_modules
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
ENV NODE_ENV=production
EXPOSE 3000
WORKDIR /app/backend
CMD ["node", "dist/server.js"]
