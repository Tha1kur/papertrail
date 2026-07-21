# syntax=docker/dockerfile:1

###############################################################################
# Build stage — needs dev dependencies; the runtime does not.
###############################################################################
FROM node:22-alpine AS build

WORKDIR /app

# Copied before the source so this layer is cached and `npm ci` is skipped on
# every rebuild that only touches application code. Package files change far
# less often than source, and installing is the slow step.
COPY package.json package-lock.json ./

# `ci` rather than `install`: it installs exactly the lockfile, fails if the
# lockfile and package.json disagree, and never silently updates a dependency
# during a build.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


###############################################################################
# Runtime stage — production dependencies and compiled output only.
###############################################################################
FROM node:22-alpine AS runtime

# dumb-init is PID 1. Node does not reap zombie processes or forward signals
# correctly as PID 1, which means SIGTERM on deploy never reaches the graceful
# shutdown handler and in-flight requests are severed instead of drained.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production

WORKDIR /app

# Run as a non-root user. The node image ships one; a container process
# running as root is a container escape away from being root on the host.
COPY --chown=node:node package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node --from=build /app/dist ./dist

USER node

EXPOSE 8080

# Kept in the image so an orchestrator can use it without extra configuration.
# Hits liveness rather than readiness: a failing readiness check means "stop
# routing to me", not "restart me", and conflating them turns a database blip
# into a restart loop.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
