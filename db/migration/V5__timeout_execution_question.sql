-- Temps limite d'exécution d'un harnais, choisi par le prof pour une question Code (ms).
-- NULL → défaut du sandbox. Borné côté execution-service (RunnerExec.MAX_RUN_TIMEOUT_MS = 60 s) :
-- le prof peut allonger le défaut pour un harnais coûteux, sans pouvoir bloquer le sandbox.
ALTER TABLE Question ADD COLUMN exec_timeout_ms INTEGER;
