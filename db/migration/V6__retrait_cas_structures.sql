-- #116 — Retrait du chemin « cas structurés » (introduit par V4).
--
-- Le projet retient le HARNAIS-CODE PARTOUT, y compris pour les langages compilés : ceux-ci sont
-- notés dans un CONTENEUR RUNNER dédié (harnais = vrai framework de test, sources verrouillées,
-- canaris — cf. docker/runners/README.md), ce qui cache l'attendu sans exposer le harnais. Les colonnes
-- structurées (expr / expected_json / compare_mode) et le gabarit d'expression par langage
-- (expr_template) n'ont donc plus de raison d'être. On les retire ici plutôt que de modifier V4
-- (déjà appliquée sur les bases de dev) : Flyway est forward-only.
--
-- harness_code redevient OBLIGATOIRE (chaque harnais porte son code). Les questions du démo sont
-- toutes en harnais-code (le démo n'a jamais utilisé les cas structurés : V4_1 est un no-op).

-- Garde-fou : aucun harnais ne doit être dépourvu de code avant de rétablir la contrainte.
UPDATE Test_Case SET harness_code = '' WHERE harness_code IS NULL;
ALTER TABLE Test_Case ALTER COLUMN harness_code SET NOT NULL;

ALTER TABLE Test_Case DROP COLUMN expr;
ALTER TABLE Test_Case DROP COLUMN expected_json;
ALTER TABLE Test_Case DROP COLUMN compare_mode;

ALTER TABLE Language DROP COLUMN expr_template;
