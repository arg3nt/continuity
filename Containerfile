# Continuity static + WebSocket server, served by Bun.
FROM docker.io/oven/bun:1.3.3-alpine

# Run as the unprivileged user provided by the base image.
WORKDIR /app

# The app has no third-party dependencies (Bun built-ins only),
# so there is nothing to install — just copy the sources.
COPY server.js index.html client.js style.css ./

ENV PORT=3099
EXPOSE 3099

USER bun
CMD ["bun", "server.js"]
