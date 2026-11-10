-- #116 — DÉMO : retour des harnais COMPILÉS au corps qui renvoie un BOOLÉEN, forme que le
-- superviseur note sans que l'étudiant puisse falsifier son résultat (deux processus, deux UID).
--
-- Miroir de V9 pour les données de démo : V7_1 avait converti ces mêmes harnais vers les
-- frameworks de test, forme ergonomique mais structurellement falsifiable. On revient à
-- l'expression booléenne, qui passe par le modèle à deux processus — le harnais et le nonce
-- vivent ailleurs que chez l'étudiant, et les objets sont proxifiés par poignée (l'instance vit
-- chez lui, ses champs privés restent privés).
--
-- Quiz « Démo — Questions de code (multi-langages) » (GIF201, cf. V2_3). Ordres : 5 Go,
-- 6 Rust, 7 C, 8 C++, 9 C#, 10 Java pour doubler(n) ; 15 Go, 16 Rust, 17 C++, 18 C#, 19 Java
-- pour l'aire d'un rectangle (POO). Idempotent sur une base sans la démo (JOIN vide).
UPDATE Test_Case SET harness_code = v.hc
FROM (VALUES
   -- ── doubler(n) : appel de fonction ──
   (5, 'double de 5', $h$return doubler(5) == 10$h$),
   (5, 'négatif', $h$return doubler(-3) == -6$h$),
   (6, 'double de 5', $h$doubler(5) == 10$h$),
   (6, 'négatif', $h$doubler(-3) == -6$h$),
   (7, 'double de 5', $h$return doubler(5) == 10;$h$),
   (7, 'négatif', $h$return doubler(-3) == -6;$h$),
   (8, 'double de 5', $h$return doubler(5) == 10;$h$),
   (8, 'négatif', $h$return doubler(-3) == -6;$h$),
   (9, 'double de 5', $h$return Solution.doubler(5) == 10;$h$),
   (9, 'négatif', $h$return Solution.doubler(-3) == -6;$h$),
   (10, 'double de 5', $h$return Solution.doubler(5) == 10;$h$),
   (10, 'négatif', $h$return Solution.doubler(-3) == -6;$h$),
   -- ── aire d'un rectangle : POO, objets proxifiés par POIGNÉE ──
   -- Go et Rust n'ont pas de constructeur, et le code de départ de la démo n'en déclare pas :
   -- le harnais écrit le LITTÉRAL À CHAMPS NOMMÉS, qui est l'idiome. Le superviseur le proxifie
   -- par capture de champs — l'objet est construit chez l'étudiant au moment de l'appel.
   (15, 'aire 3x4', $h$r := Rectangle{largeur: 3, hauteur: 4}
return r.aire() == 12$h$),
   (15, 'carré 5x5', $h$r := Rectangle{largeur: 5, hauteur: 5}
return r.aire() == 25$h$),
   (16, 'aire 3x4', $h$let r = Rectangle { largeur: 3, hauteur: 4 };
r.aire() == 12$h$),
   (16, 'carré 5x5', $h$let r = Rectangle { largeur: 5, hauteur: 5 };
r.aire() == 25$h$),
   (17, 'aire 3x4', $h$return Rectangle(3, 4).aire() == 12;$h$),
   (17, 'carré 5x5', $h$return Rectangle(5, 5).aire() == 25;$h$),
   (18, 'aire 3x4', $h$return new Rectangle(3, 4).aire() == 12;$h$),
   (18, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$),
   (19, 'aire 3x4', $h$return new Rectangle(3, 4).aire() == 12;$h$),
   (19, 'carré 5x5', $h$return new Rectangle(5, 5).aire() == 25;$h$)
) AS v(oidx, name, hc)
-- IN (et non =) : un re-seed de dev (scripts/migrate-dev-seed.sh FORCE=1) peut dupliquer le
-- quiz démo — on convertit alors TOUTES les copies au lieu de planter sur une sous-requête
-- scalaire à deux lignes. Sans doublon (CI, e2e, prod), strictement équivalent.
WHERE Test_Case.name = v.name
  AND Test_Case.question_id IN (
      SELECT qn.id FROM Question qn
      WHERE qn.order_index = v.oidx
        AND qn.quiz_id IN (SELECT id FROM Quiz
                           WHERE title = 'Démo — Questions de code (multi-langages)'
                             AND course_id IN (SELECT id FROM Course WHERE code = 'GIF201')));
