# Runner de notation C# (#116) : Mono (mcs) + NUnit/NUnitLite + superviseur.
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

RUN apt-get update \
 && apt-get install -y --no-install-recommends mono-devel python3 strace ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock \
 && mkdir -p /opt/moodit \
 && curl -fsSL -o /tmp/nunit.zip https://www.nuget.org/api/v2/package/NUnit/3.14.0 \
 && curl -fsSL -o /tmp/nunitlite.zip https://www.nuget.org/api/v2/package/NUnitLite/3.14.0 \
 && echo "0ae3ffab91e8bcf59f016dc2b72fd0c518bb5698f2909dd30cbab94c4348e8a6  /tmp/nunit.zip" | sha256sum -c - \
 && echo "75c5f1ded2ca9d510cad569d2f60d9243ebffab502c35840406333bedc4a9696  /tmp/nunitlite.zip" | sha256sum -c - \
 && unzip -j /tmp/nunit.zip "lib/net45/nunit.framework.dll" -d /opt/moodit \
 && unzip -j /tmp/nunitlite.zip "lib/net45/nunitlite.dll" -d /opt/moodit \
 && rm /tmp/nunit.zip /tmp/nunitlite.zip \
 && apt-get purge -y curl unzip && apt-get autoremove -y

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
