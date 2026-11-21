# Runner de notation C# (#116) : Mono (mcs) + superviseur. Le harnais booléen est compilé
# dans un programme séparé (le noteur), le code soumis dans un autre (le serveur).
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
    # L'invariant est VERIFIE, sur les DEUX hotes substitues et sur le MEME perimetre que le
    # sed : sans cela, une base future qui deplace la seule strophe security hors de ces
    # fichiers ferait revenir en silence le miroir a grosse reponse DNS, et la panne avec
    # lui. L'echec dit ce qui est attendu, au lieu d'un code 1 sur une commande de 400
    # caracteres : il se produira sur un bump de base ou une construction non amd64.
    { grep -q azure.archive.ubuntu.com /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null \
      && ! grep -q '//archive.ubuntu.com\|//security.ubuntu.com' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null; } \
    || { echo "ERREUR: la bascule vers azure.archive.ubuntu.com n'a pas porte sur TOUTES" >&2; \
         echo "       les sources (disposition inattendue, ou base non amd64)." >&2; exit 1; }

# Trois tentatives pour la mise a jour des index, comme pour npm plus bas dans ce depot :
# une panne DNS passagere du runner (archive.ubuntu.com non resolu) vide la liste des
# paquets. `Error-Mode=any` est indispensable : sans lui, `apt-get update` rend 0 alors
# qu'il n'a RIEN telecharge, le repli ne se declenche jamais, et l'echec ressort plus loin
# en « Unable to locate package » — un message qui accuse le paquet au lieu du reseau.
RUN (apt-get -o APT::Update::Error-Mode=any update || (sleep 5 && apt-get -o APT::Update::Error-Mode=any update) || (sleep 15 && apt-get -o APT::Update::Error-Mode=any update)) \
 && apt-get install -y --no-install-recommends mono-devel python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
