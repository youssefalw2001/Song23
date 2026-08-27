# Two stages so the runtime image carries no TypeScript compiler and no dev
# dependencies — there is nothing to build at runtime and nothing that should be
# installable from inside a running container.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# There are no runtime dependencies, but `npm ci --omit=dev` keeps this honest if
# that ever changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Customer answers and generated audio. Mount a volume here or lose both on every
# container replacement.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 8787

# Generation is slow by nature, so give the container a generous start period
# before unhealthy checks begin. /health does not touch the provider.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
