FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS fetch

ARG TUNNEL_CLIENT_VERSION=0.0.14
ARG TUNNEL_CLIENT_SHA256=15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/tunnel-client
RUN curl --fail --show-error --silent --location \
    --output tunnel-client.zip \
    "https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_CLIENT_VERSION}/tunnel-client-v${TUNNEL_CLIENT_VERSION}-linux-amd64.zip" \
  && echo "${TUNNEL_CLIENT_SHA256}  tunnel-client.zip" | sha256sum --check --strict \
  && python3 -m zipfile -e tunnel-client.zip . \
  && chmod 0755 tunnel-client cloudflared \
  && test "$(./tunnel-client --version | cut -d+ -f1)" = "${TUNNEL_CLIENT_VERSION}"

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 65532 tunnel-client \
  && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tunnel-client

COPY --from=fetch --chown=65532:65532 /tmp/tunnel-client/tunnel-client /usr/local/bin/tunnel-client
COPY --from=fetch --chown=65532:65532 /tmp/tunnel-client/cloudflared /usr/local/bin/cloudflared

USER 65532:65532
ENTRYPOINT ["tunnel-client"]
