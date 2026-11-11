# Runner de notation Java (#116) : JDK + JUnit 5 (console standalone) + superviseur.
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
FROM eclipse-temurin:25-jdk@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507

ADD --checksum=sha256:b016ef6b1c3454d6d7c2c88ce081dabf289699686af6622d6e4e2e1b54b4a2fc https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/moodit/junit-console.jar

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
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock && chmod -R go-w /var/lib/pebble \
 && chmod 644 /opt/moodit/junit-console.jar

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
