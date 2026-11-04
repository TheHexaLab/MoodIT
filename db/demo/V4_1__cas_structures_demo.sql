-- #116 — Conversion de la DÉMO vers les CAS STRUCTURÉS (suivi démo de la migration de schéma V4).
--
-- Les questions `doubler(n)` en langage COMPILÉ (Go, Rust, C, C++, C#, Java) passent du harnais-code
-- aux cas structurés : le code étudiant tourne alors en serveur RPC pur et les attendus sont comparés
-- HORS sandbox — la démo livrée bénéficie ainsi elle-même de l'isolation du harnais (le but de #116).
--
-- Entrée : `doubler` pour les fonctions libres ; `Solution.doubler` pour C#/Java (méthode statique de
-- classe, comme l'appelait le harnais). Deux cas par question : doubler(5)=10 et doubler(-3)=-6.
--
-- NON converties (restent en harnais-code, chemin deux-processus toujours supporté) :
--   - les questions POO `Rectangle(l,h).aire()` : construction d'objet + méthode, non exprimable en
--     cas structuré à arguments scalaires ;
--   - les langages interprétés et données/vues (JSON/SQL) : le harnais y est déjà hors de portée de
--     l'étudiant (serveur RPC isolé / phases SQL), la conversion n'apporterait rien.

WITH demo_quiz AS (
    SELECT id FROM Quiz
    WHERE title = 'Démo — Questions de code (multi-langages)'
      AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')
)
UPDATE Test_Case tc
SET harness_code  = NULL,
    entry         = CASE WHEN qn.order_index IN (9, 10) THEN 'Solution.doubler' ELSE 'doubler' END,
    args_json     = CASE WHEN tc.name = 'double de 5' THEN '[5]' ELSE '[-3]' END,
    expected_json = CASE WHEN tc.name = 'double de 5' THEN '10' ELSE '-6' END,
    compare_mode  = 'exact'
FROM Question qn
WHERE tc.question_id = qn.id
  AND qn.quiz_id = (SELECT id FROM demo_quiz)
  AND qn.order_index IN (5, 6, 7, 8, 9, 10)
  AND tc.name IN ('double de 5', 'négatif');
