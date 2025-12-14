FROM ghcr.io/puppeteer/puppeteer:21.6.1

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
