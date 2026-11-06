# Runner de notation Go (#116) : toolchain Go (go test) + superviseur.
# Lancé jetable par execution-service : réseau coupé, rootfs read-only, /box en tmpfs.
FROM golang:1.23-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
