FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /data && chown -R node:node /data /app

ENV CLAWMARK_PORT=3458
ENV CLAWMARK_DATA_DIR=/data

EXPOSE 3458

USER node
CMD ["node", "server/index.js"]
