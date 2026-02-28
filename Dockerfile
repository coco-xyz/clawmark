FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /data

ENV CLAWMARK_PORT=3458
ENV CLAWMARK_DATA_DIR=/data

EXPOSE 3458

CMD ["node", "server/index.js"]
