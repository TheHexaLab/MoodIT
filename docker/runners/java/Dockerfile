# Runner de notation Java (#116) : JDK + JUnit 5 (console standalone) + superviseur.
# Lancé jetable par execution-service : réseau coupé, écritures confinées aux tmpfs bornés
# /box et /tmp (les répertoires monde-inscriptibles de l'image sont verrouillés ci-dessous).
FROM eclipse-temurin:25-jdk@sha256:83f4a7fc27df94dcc7b8de04d14cbbba8da14406f921e966969c3b09000aa507

ADD --checksum=sha256:b016ef6b1c3454d6d7c2c88ce081dabf289699686af6622d6e4e2e1b54b4a2fc https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/moodit/junit-console.jar

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock && chmod -R go-w /var/lib/pebble \
 && chmod 644 /opt/moodit/junit-console.jar

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
