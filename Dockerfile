# The server image: Node.js 24 runs the TypeScript sources directly (type
# stripping), so there is no build step. Non-root; meant to run with a
# read-only root filesystem (see compose.example.yaml).

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY config/allowlist /etc/silverbullet-mcp/allowlist

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/main.ts"]
