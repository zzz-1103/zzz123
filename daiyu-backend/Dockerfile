# 林黛玉后端 · 容器配置
FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 再拷业务代码
COPY . .

# 平台会用 PORT 环境变量指定端口；没指定就默认 3000
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
