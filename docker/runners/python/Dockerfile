# Runner Python (#116, mode exec) : interprète + libs promises par le gabarit
# (numpy, pandas, scipy, sympy). Exécute les programmes assemblés (RPC 2-processus à nonce)
# et le bouton « Exécuter ». Réseau coupé, tout tourne sous l'UID étudiant.
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

RUN pip install --no-cache-dir numpy pandas scipy sympy \
 && useradd --uid 1300 --no-create-home --shell /usr/sbin/nologin student && chmod 755 /var/tmp /run/lock

COPY common/supervisor.py /opt/moodit/supervisor.py

CMD ["python3", "/opt/moodit/supervisor.py"]
