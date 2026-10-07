# Servidor do framework (para quando os canais forem integrados). Zero dependências de runtime.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY flows ./flows
COPY tenants ./tenants
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/bot.db
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
