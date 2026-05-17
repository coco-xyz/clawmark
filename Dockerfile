FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /data

ENV CLAWMARK_PORT=3458
ENV CLAWMARK_DATA_DIR=/data

RUN addgroup -S clawmark && adduser -S clawmark -G clawmark
RUN chown -R clawmark:clawmark /app /data

EXPOSE 3458

USER clawmark

CMD ["node", "server/index.js"]
