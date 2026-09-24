# Build from the repository root (the deployment config is compiled in):
#   docker build -f services/market-maker/Dockerfile -t stockstream-mm .
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY config/stockstream-deployment.json config/stockstream-deployment.json
COPY services/market-maker services/market-maker
RUN cargo build --release --locked --manifest-path services/market-maker/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 stockstream
COPY --from=build /src/services/market-maker/target/release/stockstream-market-maker /usr/local/bin/
USER stockstream
ENV MM_STATUS_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/stockstream-market-maker"]
