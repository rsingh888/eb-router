# Caddy image with Cloudflare DNS module for wildcard certificates.
FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Replacing the binary drops file capabilities; restore bind on :80/:443 as non-root.
RUN apk add --no-cache libcap \
  && setcap cap_net_bind_service=+ep /usr/bin/caddy \
  && apk del libcap \
  && chown root:root /usr/bin/caddy

# Official image ships a non-root `caddy` user (uid 1000).
USER caddy

# Admin API listens on localhost:2019 by default — use it as a liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2019/config/ >/dev/null || exit 1
