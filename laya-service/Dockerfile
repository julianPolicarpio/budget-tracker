FROM node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.mjs ./

ENV NODE_ENV=production \
	PORT=3010 \
	LAYA_CACHE=/models

EXPOSE 3010

CMD ["node", "server.mjs"]
