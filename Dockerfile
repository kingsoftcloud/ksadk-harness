ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /source
COPY . .
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
RUN npm run build && mkdir /packages && \
    npm pack --ignore-scripts --pack-destination /packages \
      -w @kingsoftcloud/agentkit-harness-core -w @kingsoftcloud/agentkit-harness-node
WORKDIR /runtime
RUN --mount=type=cache,target=/root/.npm npm install --ignore-scripts --omit=dev --no-audit --no-fund /packages/*.tgz

FROM ${NODE_IMAGE}
WORKDIR /opt/harness
COPY --from=build /runtime/node_modules ./node_modules
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/state /data/workspace && chown node:node /data /data/state /data/workspace
USER node
ENV AGENTKIT_ENGINE_SERVICE_HOST=0.0.0.0
EXPOSE 8787
ENTRYPOINT ["/opt/harness/node_modules/.bin/agentkit-engine-service"]
CMD ["--workspace", "/data/workspace", "--state-dir", "/data/state"]
