FROM node:20-alpine

WORKDIR /app

COPY ev-dashboard/package.json ./package.json
COPY ev-dashboard/server.js ./server.js
COPY ev-dashboard/public ./public

ENV NODE_ENV=production
ENV APP_DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
