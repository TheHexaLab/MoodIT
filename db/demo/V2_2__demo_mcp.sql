-- ============================================================================
--  V2.2 — Démo : cours contrastés pour l'analyse MCP (MCP100, MCP200, MCP150)
-- ============================================================================
-- Données de DÉMO (dev, e2e, CI ; jamais en prod). Chargées par Flyway seulement quand db/demo fait
-- partie de FLYWAY_LOCATIONS (compose de dev et e2e, deploy/reset-data.sh).

-- ============================================================
--  Démo MCP — deux cours contrastés pour l'analyse de cours.
--  Le score MCP dépend de 3 signaux : nb de quiz, nb de messages de forum,
--  nb d'étudiants inscrits.
--    MCP100 (actif)   : 8 quiz + 40 messages + 3 inscrits  → BONNE note.
--    MCP200 (inactif) : aucun quiz/message, aucun inscrit  → MAUVAISE note.
-- ============================================================

-- Rendre les deux cours visibles par l'admin : l'analyse MCP est réservée aux
-- administrateurs, et l'admin doit être abonné à un programme contenant le cours
-- (cf. autorisation canSeeCourse : program_course ↔ User_Program).
INSERT INTO program_course (program_id, course_id) VALUES
  (1, (SELECT id FROM Course WHERE code = 'MCP100')),
  (1, (SELECT id FROM Course WHERE code = 'MCP200'));

-- Abonner l'admin (user 1) au programme GIN (1) pour qu'il voie ces cours.
INSERT INTO User_Program (program_id, user_id) VALUES (1, 1);

-- Abonner mich (user 3) au programme GIN (1) aussi.
INSERT INTO User_Program (program_id, user_id) VALUES (1, 3);

-- ---- MCP100 (bonne note) : 3 inscrits, 10 quiz, ~22 messages avec de VRAIS avis,
-- un quiz de code tenté (≈78% de cas de test) et un quiz auto-corrigé tenté (67% de moyenne).
-- De quoi laisser l'agent MCP juger le RESSENTI (messages) et la RÉUSSITE (quiz + code). ----

INSERT INTO Enrollment (course_id, user_id)
SELECT (SELECT id FROM Course WHERE code = 'MCP100'), s.u
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
SELECT 'Quiz ' || g, FALSE, TRUE, FALSE, g,
       (SELECT id FROM Course WHERE code = 'MCP100')
FROM generate_series(1, 8) AS g;

-- Messages de forum réalistes (avis positifs ET négatifs) pour l'analyse du ressenti.
INSERT INTO Post (content, forum_id, user_id, is_pinned)
SELECT m.content,
       (SELECT f.id FROM Forum f
        WHERE f.course_id = (SELECT id FROM Course WHERE code = 'MCP100')
          AND f.f_type_id = 1),
       m.uid,
       FALSE
FROM (VALUES
   ('Franchement le cours est super clair, les explications aident vraiment à comprendre.', 2),
   ('Les quiz hebdomadaires sont parfaits pour réviser, j''adore ce format.', 3),
   ('Les exemples de code en classe sont très concrets, ça aide énormément.', 2),
   ('Merci pour la rétroaction rapide sur le forum, ça change tout.', 1),
   ('Le rythme est bien dosé, on a le temps d''assimiler la matière.', 3),
   ('J''ai enfin compris les boucles grâce aux exercices, vraiment top.', 2),
   ('La correction automatique des quiz est super pratique.', 3),
   ('Un des meilleurs cours du trimestre, bravo pour l''organisation.', 2),
   ('J''apprécie qu''on puisse refaire les quiz pour s''améliorer.', 3),
   ('Le forum est actif, on obtient de l''aide rapidement.', 1),
   ('Merci pour la disponibilité, ça motive à travailler.', 3),
   ('Les rétroactions détaillées sur mes réponses m''aident à progresser.', 2),
   ('Par contre les délais des travaux sont trop serrés, j''ai du mal à suivre.', 2),
   ('Le dernier quiz était beaucoup plus dur que les précédents, c''était déstabilisant.', 3),
   ('La section sur la récursivité va trop vite à mon goût.', 1),
   ('La charge de travail est un peu lourde cette semaine.', 2),
   ('Certains énoncés d''exercices manquent de précision.', 3),
   ('Un peu plus d''exemples pratiques seraient les bienvenus.', 2),
   ('Est-ce qu''on peut avoir un exemple supplémentaire sur les dictionnaires ?', 3),
   ('À quelle heure a lieu la séance de révision svp ?', 2),
   ('Le lien du quiz 3 fonctionne bien de mon côté.', 1),
   ('Bonne organisation générale, mais la dernière semaine était chargée.', 3)
) AS m(content, uid);

-- Quiz noté avec une question de CODE + 3 cas de test, tenté par les 3 étudiants.
-- Résultats semés : user 1 → 3/3, users 2 et 3 → 2/3 (échec du 3e test) = 7/9 ≈ 78%.
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — exercice de code', FALSE, TRUE, FALSE, 9,
        (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Question (prompt, language_id, start_code, order_index, total_score, q_type_id, quiz_id)
VALUES ('Écris une fonction somme(a, b) qui renvoie la somme de deux entiers.',
        (SELECT id FROM Language WHERE name = 'Python'),
        'def somme(a, b):' || chr(10) || '    pass', 0, 3, 6,
        (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')));

-- Le harnais Python doit RENVOYER un booléen (contrat : verdict = bool(harnais())) ; un `assert`
-- renverrait None → toujours faux même sur une bonne réponse. Cf. CodeAssembler.assemblePython.
INSERT INTO Test_Case (name, harness_code, weight, question_id)
SELECT 'Test ' || g, 'return somme(1, 2) == 3', 1,
       (SELECT id FROM Question
        WHERE q_type_id = 6
          AND quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')))
FROM generate_series(1, 3) AS g;

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT 'def somme(a, b): return a + b', a.id,
       (SELECT id FROM Question WHERE q_type_id = 6 AND quiz_id = a.quiz_id),
       a.user_id
FROM Attempt a
WHERE a.quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                       AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Submission_Test_Case (submission_id, test_case_id, passed)
SELECT sub.id, tc.id,
       CASE WHEN sub.uid = 1 THEN TRUE       -- user 1 réussit les 3 tests
            WHEN tc.rnk = 3 THEN FALSE        -- users 2 et 3 échouent le 3e
            ELSE TRUE END
FROM (SELECT s.id, s.user_id AS uid
      FROM Submission s JOIN Attempt a ON a.id = s.attempt_id
      WHERE a.quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                             AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'))) sub
CROSS JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rnk
            FROM Test_Case
            WHERE question_id = (SELECT id FROM Question
                 WHERE q_type_id = 6
                   AND quiz_id = (SELECT id FROM Quiz WHERE title = 'Quiz noté — exercice de code'
                                                      AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')))) tc;

-- Quiz noté AUTO-CORRIGÉ (V/F + choix unique) tenté par les 3 étudiants. Réussite semée :
-- user1 = 2/2 (100%), user2 = 1/2 (50%), user3 = 1/2 (50%) → moyenne = 67%. Core recalcule
-- cette moyenne à la volée (endpoint interne quiz-stats) pour l'analyse MCP.
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — révision', FALSE, TRUE, FALSE, 10,
        (SELECT id FROM Course WHERE code = 'MCP100'));

INSERT INTO Question (prompt, order_index, total_score, q_type_id, quiz_id)
SELECT p.prompt, p.oidx, 1, p.qtype,
       (SELECT id FROM Quiz WHERE title = 'Quiz noté — révision'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100'))
FROM (VALUES
   ('Une pile (stack) fonctionne selon le principe LIFO.', 0, 1),  -- Vrai/Faux (q_type 1)
   ('Quelle structure suit le principe FIFO ?',            1, 2)   -- Choix unique (q_type 2)
) AS p(prompt, oidx, qtype);

-- Options de la Q1 (Vrai/Faux)
INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — révision'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100') AND q.order_index = 0)
FROM (VALUES ('Vrai', TRUE), ('Faux', FALSE)) AS c(content, ok);

-- Options de la Q2 (Choix unique)
INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — révision'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100') AND q.order_index = 1)
FROM (VALUES ('File (queue)', TRUE), ('Pile (stack)', FALSE), ('Arbre binaire', FALSE)) AS c(content, ok);

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — révision'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP100')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

-- Soumissions (content = JSON SubmittedAnswerDTO {"answerIds":[id]}). Pour chaque (user, question,
-- correct?), on choisit un id de réponse dont is_correct correspond au flag.
INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT '{"answerIds":[' || ans.id || ']}', att.id, q.id, att.user_id
FROM (VALUES
   (1, 0, TRUE), (1, 1, TRUE),    -- user 1 : les deux bonnes  → 100%
   (2, 0, TRUE), (2, 1, FALSE),   -- user 2 : Q1 bonne, Q2 fausse → 50%
   (3, 0, FALSE), (3, 1, TRUE)    -- user 3 : Q1 fausse, Q2 bonne → 50%
) AS s(uid, oidx, correct)
JOIN Quiz z ON z.title = 'Quiz noté — révision'
           AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP100')
JOIN Question q ON q.quiz_id = z.id AND q.order_index = s.oidx
JOIN Attempt att ON att.quiz_id = z.id AND att.user_id = s.uid AND att.attempt_no = 1
JOIN LATERAL (
    SELECT a.id FROM Answer a
    WHERE a.question_id = q.id AND a.is_correct = s.correct
    ORDER BY a.id LIMIT 1
) ans ON TRUE;

-- ---- MCP200 (mauvaise note) : volontairement VIDE ----
-- Ses deux forums (auto-créés plus haut) restent sans message ; aucun quiz,
-- aucun inscrit → l'analyse ne trouve que des axes d'amélioration.

-- ============================================================
--  Démo MCP — cours MOYEN (MCP150) : signaux TIÈDES → score attendu en zone « warning »
--  (50-69%, front). 6 quiz (dont 1 auto-corrigé à ~67% de moyenne), ~9 messages d'avis
--  MITIGÉS et ÉQUILIBRÉS (positif/neutre/négatif), 3 inscrits. Calibré pour que le LLM
--  (qwen2.5) lise « moyen », pas seulement le repli déterministe qui donnait 59.
--  NB : le score LLM n'est pas déterministe (température 0.2) → il peut osciller de
--  quelques points d'une analyse à l'autre.
-- ============================================================

INSERT INTO program_course (program_id, course_id) VALUES
  (1, (SELECT id FROM Course WHERE code = 'MCP150'));

INSERT INTO Enrollment (course_id, user_id)
SELECT (SELECT id FROM Course WHERE code = 'MCP150'), s.u
FROM (VALUES (1), (2), (3)) AS s(u);

-- 5 quiz génériques (pour le compte de quiz — signal « contenu » moyen, pas famélique).
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
SELECT 'Quiz ' || g, FALSE, TRUE, FALSE, g, (SELECT id FROM Course WHERE code = 'MCP150')
FROM generate_series(1, 5) AS g;

-- Messages de forum MITIGÉS (ni enthousiastes ni catastrophés).
INSERT INTO Post (content, forum_id, user_id, is_pinned)
SELECT m.content,
       (SELECT f.id FROM Forum f
        WHERE f.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND f.f_type_id = 1),
       m.uid, FALSE
FROM (VALUES
   ('Le cours est plutôt bien structuré et le prof reste disponible.', 1),
   ('Les quiz aident vraiment à réviser, j''ai senti une progression.', 2),
   ('Bonne ambiance générale, le contenu est correct dans l''ensemble.', 3),
   ('J''apprécie les retours du prof sur les exercices.', 1),
   ('Ça va, sans plus, j''attends de voir la suite.', 3),
   ('Les délais sont serrés mais gérables.', 2),
   ('Les explications manquent parfois de clarté sur les points avancés.', 2),
   ('Le rythme est un peu rapide par moments.', 3),
   ('On manque d''exemples concrets sur certains sujets.', 2)
) AS m(content, uid);

-- Quiz auto-corrigé « Quiz noté — mi-parcours » : moyenne 50% (chacun 1/2).
INSERT INTO Quiz (title, is_daily, is_published, allow_retry, position, course_id)
VALUES ('Quiz noté — mi-parcours', FALSE, TRUE, FALSE, 6,
        (SELECT id FROM Course WHERE code = 'MCP150'));

INSERT INTO Question (prompt, order_index, total_score, q_type_id, quiz_id)
SELECT p.prompt, p.oidx, 1, p.qtype,
       (SELECT id FROM Quiz WHERE title = 'Quiz noté — mi-parcours'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP150'))
FROM (VALUES
   ('Un tableau permet un accès direct par indice.', 0, 1),  -- Vrai/Faux
   ('Quelle est la complexité de la recherche binaire ?', 1, 2)  -- Choix unique
) AS p(prompt, oidx, qtype);

INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — mi-parcours'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND q.order_index = 0)
FROM (VALUES ('Vrai', TRUE), ('Faux', FALSE)) AS c(content, ok);

INSERT INTO Answer (content, is_correct, question_id)
SELECT c.content, c.ok,
       (SELECT q.id FROM Question q JOIN Quiz z ON z.id = q.quiz_id
        WHERE z.title = 'Quiz noté — mi-parcours'
          AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150') AND q.order_index = 1)
FROM (VALUES ('O(log n)', TRUE), ('O(n)', FALSE), ('O(n²)', FALSE)) AS c(content, ok);

INSERT INTO Attempt (quiz_id, user_id, attempt_no)
SELECT (SELECT id FROM Quiz WHERE title = 'Quiz noté — mi-parcours'
                            AND course_id = (SELECT id FROM Course WHERE code = 'MCP150')), s.u, 1
FROM (VALUES (1), (2), (3)) AS s(u);

INSERT INTO Submission (content, attempt_id, question_id, user_id)
SELECT '{"answerIds":[' || ans.id || ']}', att.id, q.id, att.user_id
FROM (VALUES
   (1, 0, TRUE), (1, 1, TRUE),     -- user 1 : 2/2 → 100%
   (2, 0, TRUE), (2, 1, FALSE),    -- user 2 : 1/2 → 50%
   (3, 0, FALSE), (3, 1, TRUE)     -- user 3 : 1/2 → 50% (moyenne = 4/6 ≈ 67%)
) AS s(uid, oidx, correct)
JOIN Quiz z ON z.title = 'Quiz noté — mi-parcours'
           AND z.course_id = (SELECT id FROM Course WHERE code = 'MCP150')
JOIN Question q ON q.quiz_id = z.id AND q.order_index = s.oidx
JOIN Attempt att ON att.quiz_id = z.id AND att.user_id = s.uid AND att.attempt_no = 1
JOIN LATERAL (
    SELECT a.id FROM Answer a
    WHERE a.question_id = q.id AND a.is_correct = s.correct
    ORDER BY a.id LIMIT 1
) ans ON TRUE;
