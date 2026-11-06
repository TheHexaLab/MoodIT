# Runner de notation C et C++ (#116) : gcc/g++ + moodit_check.h + superviseur.
# Une seule image pour les deux langages (même toolchain).
# Lancé jetable par execution-service : réseau coupé, rootfs read-only, /box en tmpfs.
FROM gcc:14-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student

COPY common/supervisor.py /opt/moodit/supervisor.py
COPY common/moodit_check.h /opt/moodit/moodit_check.h

CMD ["python3", "/opt/moodit/supervisor.py"]
