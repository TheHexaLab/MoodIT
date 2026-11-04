-- #116 — Cas STRUCTURÉS pour les questions « appel de fonction ».
--
-- Nouveau modèle de notation : le code étudiant est exécuté comme SERVEUR RPC pur (sans harnais ni
-- attendu dans le sandbox) ; execution-service envoie les entrées et compare les sorties aux attendus
-- LUI-MÊME. Les attendus et le verdict ne touchent donc jamais le sandbox (indispensable pour les
-- langages compilés, dont le harnais-code ne peut pas être caché au processus étudiant).
--
-- Colonnes AJOUTÉES sur Test_Case (toutes nullables) ; harness_code devient OPTIONNEL : une question
-- à cas structurés porte (entry, args_json, expected_json, compare_mode) au lieu d'un harness_code.
-- Les questions existantes (harnais-code : interprétés, HTML/JSX/SQL) restent valides et inchangées.
ALTER TABLE Test_Case ALTER COLUMN harness_code DROP NOT NULL;
ALTER TABLE Test_Case ADD COLUMN entry VARCHAR(200);
ALTER TABLE Test_Case ADD COLUMN args_json TEXT;
ALTER TABLE Test_Case ADD COLUMN expected_json TEXT;
ALTER TABLE Test_Case ADD COLUMN compare_mode VARCHAR(20);
