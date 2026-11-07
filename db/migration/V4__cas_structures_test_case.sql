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

-- Gabarit d'EXPRESSION par langage (pendant structuré de harness_template, cf. V2). L'éditeur prof
-- pré-remplit un nouveau cas avec ce squelette commenté, propre à la convention de retour du langage.
-- Seuls les langages COMPILÉS en ont un (les autres restent en harnais-code). V2 étant déjà fusionnée,
-- on sème ici par UPDATE plutôt qu'en modifiant son INSERT.
ALTER TABLE Language ADD COLUMN expr_template TEXT;

UPDATE Language SET expr_template = et.tpl
FROM (VALUES
    ('Go',   E'// Appelez la fonction de l''étudiant et renvoyez la valeur à vérifier.\nreturn doubler(5)'),
    ('Rust', E'// Renvoyez la valeur à vérifier (dernière valeur du bloc, sans `return` ni `;`).\ndoubler(5)'),
    ('C',    E'// Appelez la fonction de l''étudiant et renvoyez la valeur à vérifier.\nreturn doubler(5);'),
    ('C++',  E'// Appelez la fonction de l''étudiant et renvoyez la valeur à vérifier.\nreturn doubler(5);'),
    ('C#',   E'// Appelez la méthode de l''étudiant et renvoyez la valeur à vérifier.\nreturn Solution.doubler(5);'),
    ('Java', E'// Appelez la méthode de l''étudiant et renvoyez la valeur à vérifier.\nreturn Solution.doubler(5);')
) AS et(name, tpl)
WHERE Language.name = et.name;
