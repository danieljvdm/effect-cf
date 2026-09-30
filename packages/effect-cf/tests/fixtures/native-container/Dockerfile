FROM oven/bun:1.4.0

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

ENTRYPOINT ["sleep", "infinity"]
