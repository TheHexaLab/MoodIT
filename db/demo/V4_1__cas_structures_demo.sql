-- #116 — Conversion de la DÉMO vers les CAS STRUCTURÉS (suivi démo de la migration de schéma V4).
--
-- Les questions en langage COMPILÉ — doubler(n) (fonction) ET Rectangle.aire() (POO) — passent du
-- harnais-code à une EXPRESSION qui renvoie la valeur testée. Le code étudiant est alors évalué dans un
-- serveur et la sortie est comparée à l'attendu HORS sandbox : la démo livrée bénéficie elle-même de
-- l'isolation du harnais (attendus jamais exposés), y compris pour la POO.
--
-- L'expression suit la convention de chaque langage (Go : `return X` ; Rust : X en valeur de bloc ;
-- C/C++/C#/Java : `return X;`). Les questions interprétées et données/vues (JSON/SQL) restent en
-- harnais-code (déjà hors de portée de l'étudiant). Il n'y a pas de question POO en C (pas de classe).

WITH conv(oidx, cname, cexpr, cexpected) AS (VALUES
    -- doubler(n) : Go(5) Rust(6) C(7) C++(8) C#(9) Java(10)
    (5,  'double de 5', 'return doubler(5)',              '10'),
    (5,  'négatif',     'return doubler(-3)',             '-6'),
    (6,  'double de 5', 'doubler(5)',                     '10'),
    (6,  'négatif',     'doubler(-3)',                    '-6'),
    (7,  'double de 5', 'return doubler(5);',             '10'),
    (7,  'négatif',     'return doubler(-3);',            '-6'),
    (8,  'double de 5', 'return doubler(5);',             '10'),
    (8,  'négatif',     'return doubler(-3);',            '-6'),
    (9,  'double de 5', 'return Solution.doubler(5);',    '10'),
    (9,  'négatif',     'return Solution.doubler(-3);',   '-6'),
    (10, 'double de 5', 'return Solution.doubler(5);',    '10'),
    (10, 'négatif',     'return Solution.doubler(-3);',   '-6'),
    -- Rectangle.aire() (POO) : Go(15) Rust(16) C++(17) C#(18) Java(19)
    (15, 'aire 3x4',  'return Rectangle{largeur: 3, hauteur: 4}.aire()', '12'),
    (15, 'carré 5x5', 'return Rectangle{largeur: 5, hauteur: 5}.aire()', '25'),
    (16, 'aire 3x4',  'Rectangle { largeur: 3, hauteur: 4 }.aire()',     '12'),
    (16, 'carré 5x5', 'Rectangle { largeur: 5, hauteur: 5 }.aire()',     '25'),
    (17, 'aire 3x4',  'return Rectangle(3, 4).aire();',                  '12'),
    (17, 'carré 5x5', 'return Rectangle(5, 5).aire();',                  '25'),
    (18, 'aire 3x4',  'return new Rectangle(3, 4).aire();',              '12'),
    (18, 'carré 5x5', 'return new Rectangle(5, 5).aire();',              '25'),
    (19, 'aire 3x4',  'return new Rectangle(3, 4).aire();',              '12'),
    (19, 'carré 5x5', 'return new Rectangle(5, 5).aire();',              '25')
)
UPDATE Test_Case tc
SET harness_code  = NULL,
    expr          = conv.cexpr,
    expected_json = conv.cexpected,
    compare_mode  = 'exact'
FROM conv, Question qn
WHERE tc.question_id = qn.id
  AND qn.order_index = conv.oidx
  AND tc.name = conv.cname
  AND qn.quiz_id = (SELECT id FROM Quiz
                    WHERE title = 'Démo — Questions de code (multi-langages)'
                      AND course_id = (SELECT id FROM Course WHERE code = 'GIF201'));
