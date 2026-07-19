# Telemetry collector container — joined to traefik's docker network so traefik
# reaches it by name (telemetry-collector:5599), no host↔bridge firewall in play.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV COLLECTOR_HOST=0.0.0.0 \
    COLLECTOR_PORT=5599 \
    COLLECTOR_DATA_DIR=/data
EXPOSE 5599
CMD ["node", "server.mjs"]
