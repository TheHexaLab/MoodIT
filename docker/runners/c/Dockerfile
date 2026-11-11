# Runner de notation C et C++ (#116) : gcc/g++ + moodit_check.h + superviseur.
# Une seule image pour les deux langages (même toolchain).
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
FROM gcc:14-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15

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
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock

COPY common/supervisor.py /opt/moodit/supervisor.py
COPY common/moodit_check.h /opt/moodit/moodit_check.h

CMD ["python3", "/opt/moodit/supervisor.py"]
