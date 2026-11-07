# Runner Node (#116, mode exec) : JavaScript, TypeScript (tsc), et les harnais JS des
# langages « données/vues » (JSON, HTML, JSX, TSX — leurs bundles vendor arrivent avec le job).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g typescript@5.6.3 \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
