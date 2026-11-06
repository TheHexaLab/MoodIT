# Runner de notation C# (#116) : Mono (mcs) + NUnit/NUnitLite + superviseur.
# Lancé jetable par execution-service : réseau coupé, rootfs read-only, /box en tmpfs.
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends mono-devel python3 strace ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student \
 && mkdir -p /opt/moodit \
 && curl -fsSL -o /tmp/nunit.zip https://www.nuget.org/api/v2/package/NUnit/3.14.0 \
 && curl -fsSL -o /tmp/nunitlite.zip https://www.nuget.org/api/v2/package/NUnitLite/3.14.0 \
 && unzip -j /tmp/nunit.zip "lib/net45/nunit.framework.dll" -d /opt/moodit \
 && unzip -j /tmp/nunitlite.zip "lib/net45/nunitlite.dll" -d /opt/moodit \
 && rm /tmp/nunit.zip /tmp/nunitlite.zip \
 && apt-get purge -y curl unzip && apt-get autoremove -y

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
