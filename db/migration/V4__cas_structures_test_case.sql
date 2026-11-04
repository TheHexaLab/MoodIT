-- #116 — Cas STRUCTURÉS pour les questions « appel de fonction ».
--
-- Nouveau modèle de notation : le code étudiant est exécuté comme SERVEUR RPC pur (sans harnais ni
-- attendu dans le sandbox) ; execution-service envoie les entrées et compare les sorties aux attendus
-- LUI-MÊME. Les attendus et le verdict ne touchent donc jamais le sandbox (indispensable pour les
-- langages compilés, dont le harnais-code ne peut pas être caché au processus étudiant).
--
-- Colonnes AJOUTÉES sur Test_Case (toutes nullables) ; harness_code devient OPTIONNEL : une question
-- à cas structurés porte (expr, expected_json, compare_mode) au lieu d'un harness_code. `expr` est une
-- EXPRESSION, dans le langage de la question, qui RENVOIE la valeur testée (appel de fonction,
-- construction d'objet + méthode, séquence) ; execution-service l'évalue dans un serveur et compare la
-- sortie à expected_json HORS sandbox. Les questions existantes (harnais-code) restent valides.
ALTER TABLE Test_Case ALTER COLUMN harness_code DROP NOT NULL;
ALTER TABLE Test_Case ADD COLUMN expr TEXT;
ALTER TABLE Test_Case ADD COLUMN expected_json TEXT;
ALTER TABLE Test_Case ADD COLUMN compare_mode VARCHAR(20);
