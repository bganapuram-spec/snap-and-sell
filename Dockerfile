# Production image. Node 22.18+ runs the .ts files directly (type stripping), so there's no build step.
FROM node:22.20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# Read-only sales data ships in the image; the shop and agent ids are saved in Upstash (see render.yaml).
COPY data/resale_sales.csv data/past_sales.SAMPLE.csv ./data/

EXPOSE 3000
# No --env-file here: the host sets ZOOWORK_API_KEY, MERCHANT_TOKEN, UPSTASH_REDIS_REST_URL/TOKEN and PORT.
CMD ["node", "src/server.ts"]
