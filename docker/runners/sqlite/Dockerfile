# Runner SQLite (#116, mode exec) : notation SQL (vues solutionN, isolation 2 phases pilotée
# par execution-service — deux conteneurs par harnais de modification).
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
