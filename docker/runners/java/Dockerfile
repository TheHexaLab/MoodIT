# Runner de notation Java (#116) : JDK + JUnit 5 (console standalone) + superviseur.
# Lancé jetable par execution-service : réseau coupé, rootfs read-only, /box en tmpfs.
FROM eclipse-temurin:25-jdk

ADD https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/moodit/junit-console.jar

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 strace \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student \
 && chmod 644 /opt/moodit/junit-console.jar

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
