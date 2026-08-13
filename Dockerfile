# Fieldscope — evidence-first OT/IT diagnostics workbench.
#
# Multi-stage build: server deps (native better-sqlite3 compiled where no
# prebuild exists) and the Vite client build happen in full toolchain images;
# the runtime is a slim image running as an unprivileged user with the evidence
# store on a /data volume.
#
#   docker build -t fieldscope .
#   docker run -p 5100:5100 -v fieldscope-data:/data fieldscope
#
# Note the container-vs-instrument tradeoff: TCP/UDP drivers (Modbus, EtherNet/IP,
# MQTT, SNMP, DNS, TLS, TCP probe) work fully. ICMP ping needs CAP_NET_RAW
# (`--cap-add NET_RAW`) or falls back to the driver's TCP-based reachability
# facts; L2/pcap tiers are out of container scope by design (§10).

FROM node:22-bookworm AS server-deps
WORKDIR /build
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm AS client-build
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=5100 \
    FIELDSCOPE_DATA=/data
WORKDIR /app

COPY --from=server-deps /build/node_modules server/node_modules
COPY server/ server/
COPY --from=client-build /build/dist client/dist

RUN groupadd -r fieldscope && useradd -r -g fieldscope fieldscope \
    && mkdir -p /data && chown -R fieldscope:fieldscope /data

USER fieldscope
EXPOSE 5100
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
