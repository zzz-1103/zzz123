# 林黛玉后端（代码在 daiyu-backend/ 子文件夹）
FROM node:20-alpine

WORKDIR /app

COPY daiyu-backend/package.json ./
RUN npm install --omit=dev

COPY daiyu-backend/ ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]