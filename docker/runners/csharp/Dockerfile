# Runner de notation C# (#116) : Mono (mcs) + NUnit/NUnitLite + superviseur.
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

# Miroir Azure au lieu d'archive.ubuntu.com (12 A + 12 AAAA : reponse DNS trop grosse pour
# un UDP classique, donc irresolvable des qu'EDNS0 ou le repli TCP est casse sur le runner).
# Celui-ci publie UNE adresse. C'est le miroir des runners GitHub, et les constructions
# de production (deploy/update.sh, sur le VPS) passent desormais par lui aussi. L'integrite est inchangee :
# apt verifie la signature de l'archive, pas le miroir. Les deux formats de sources sont
# couverts (sources.list hérité, et ubuntu.sources en deb822 depuis Ubuntu 24.04).
RUN sed -i 's|//archive.ubuntu.com|//azure.archive.ubuntu.com|g; s|//security.ubuntu.com|//azure.archive.ubuntu.com|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    # L'invariant est VERIFIE : sans ce controle, une disposition de sources differente dans
    # une base future (bump de digest, image arm64 ou l'URI est ports.ubuntu.com) ferait
    # revenir le miroir a grosse reponse DNS en silence, et la panne avec lui.
    grep -rq azure.archive.ubuntu.com /etc/apt/sources.list /etc/apt/sources.list.d/ && ! grep -rq '//archive.ubuntu.com' /etc/apt/sources.list /etc/apt/sources.list.d/

# Trois tentatives pour la mise a jour des index, comme pour npm plus bas dans ce depot :
# une panne DNS passagere du runner (archive.ubuntu.com non resolu) vide la liste des
# paquets. `Error-Mode=any` est indispensable : sans lui, `apt-get update` rend 0 alors
# qu'il n'a RIEN telecharge, le repli ne se declenche jamais, et l'echec ressort plus loin
# en « Unable to locate package » — un message qui accuse le paquet au lieu du reseau.
RUN (apt-get -o APT::Update::Error-Mode=any update || (sleep 5 && apt-get -o APT::Update::Error-Mode=any update) || (sleep 15 && apt-get -o APT::Update::Error-Mode=any update)) \
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
