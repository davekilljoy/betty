# Betty on Fly. better-sqlite3 needs build tools at install time.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY . .

FROM node:22-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=3000 BETTY_DB=/data/betty.db
EXPOSE 3000
CMD ["node", "src/server.js"]
