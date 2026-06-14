FROM node:lts-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev


FROM node:lts-alpine

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

CMD ["node", "index.js"]
