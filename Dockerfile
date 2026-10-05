# Anotify 服务端镜像（设计见 DESIGN.md §6/§8）
FROM node:20-bookworm-slim

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY anotify-backend/package.json anotify-backend/
COPY anotify-client-cli/package.json anotify-client-cli/
RUN npm ci --omit=dev

COPY anotify-backend/src anotify-backend/src/
COPY anotify-backend/scripts anotify-backend/scripts/

ENV NODE_ENV=production \
    ANOTIFY_FILES_DIR=/data/files \
    HOST=0.0.0.0 \
    PORT=8000

# 上传临时文件目录；SQLite 时代的数据也在这里（一次性迁移的数据源）
VOLUME /data
EXPOSE 8000

CMD ["node", "anotify-backend/src/server.js"]
