# Runner Node (#116, mode exec) : JavaScript, TypeScript (tsc), et les harnais JS des
# langages « données/vues » (JSON, HTML, JSX, TSX — leurs bundles vendor arrivent avec le job).
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# typescript : tarball vérifié par EMPREINTE (#24, comme le jar JUnit et les NuGet) — une
# version npm peut être republiée, le hash non. Mise à jour : `npm pack typescript@<v>` puis
# `sha256sum` du .tgz.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/* \
 && cd /tmp \
 && npm pack typescript@5.6.3 --silent \
 && echo "ef67f8d8ad895858024b7339d3e34bf112cae3c5db1f538c3079038b17ae30fa  typescript-5.6.3.tgz" | sha256sum -c - \
 && npm install -g ./typescript-5.6.3.tgz \
 && rm typescript-5.6.3.tgz \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
