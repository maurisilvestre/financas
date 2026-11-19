# Imagem do backend: serviços "sync", "migrate", "mcp" e "web" (comandos de src/main.ts).
# O Node 24 executa TypeScript direto (type stripping), então o backend não tem build.
# O front (web/, Vue + Vite) é compilado num estágio à parte; só o resultado entra na imagem.

# O front sai como arquivos estáticos, iguais em qualquer CPU: este estágio roda na plataforma de
# quem faz a build (o Mac, no deploy.sh), sem emular amd64 para o Vite/esbuild.
FROM --platform=$BUILDPLATFORM node:24-alpine AS front
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --ignore-scripts
COPY web/index.html web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
RUN npm run build

FROM node:24-alpine

ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations

WORKDIR /app

# Só dependências de produção, sem scripts de instalação (proteção de supply chain).
COPY sync/package.json sync/package-lock.json sync/.npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY sync/src ./src
COPY db/migrations ./migrations
COPY --from=front /web/dist ./web

USER node
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
CMD ["daemon"]
