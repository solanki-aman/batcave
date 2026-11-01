FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV PORT=4777 BATCAVE_DATA=/data/batcave.json
VOLUME ["/data"]
EXPOSE 4777
CMD ["node", "src/index.mjs"]
