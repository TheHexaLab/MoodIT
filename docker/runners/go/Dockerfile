# Runner de notation Go (#116) : toolchain Go (go test) + superviseur.
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
# cgo inutile aux harnais et surface en moins pour la compilation ROOT de sources non fiables.
FROM golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db

ENV CGO_ENABLED=0

# Trois tentatives pour la mise a jour des index, comme pour npm plus bas dans ce depot :
# une panne DNS passagere du runner vide la liste des paquets (cette image tire de
# deb.debian.org ; le cas d'archive.ubuntu.com, a grosse reponse DNS, ne concerne que les
# images java et csharp, qui basculent sur un miroir dedie).
# `Error-Mode=any` est indispensable : sans lui, `apt-get update` rend 0 alors
# qu'il n'a RIEN telecharge, le repli ne se declenche jamais, et l'echec ressort plus loin
# en « Unable to locate package » — un message qui accuse le paquet au lieu du reseau.
RUN (apt-get -o APT::Update::Error-Mode=any update || (sleep 5 && apt-get -o APT::Update::Error-Mode=any update) || (sleep 15 && apt-get -o APT::Update::Error-Mode=any update)) \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock && chmod -R go-w /go

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
