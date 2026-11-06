# Runner de notation Rust (#116) : toolchain Rust (cargo test) + superviseur.
# Lancé jetable par execution-service : réseau coupé, rootfs read-only, /box en tmpfs.
FROM rust:1.82-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
