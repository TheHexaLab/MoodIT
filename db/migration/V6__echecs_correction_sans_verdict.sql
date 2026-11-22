-- #116, S4 — Échecs de correction SANS VERDICT, par étudiant et par quiz.
--
-- Quand le conteneur runner tourne mais ne rend aucun verdict (superviseur muet ou illisible, mur
-- atteint, notation incomplète), execution-service répond 502 de cause « sans_verdict ». Core
-- supprimait alors la tentative et l'étudiant resoumettait, à volonté : sur une question à
-- tentative unique, un code soumis capable de provoquer cet échec obtenait autant d'essais qu'il
-- voulait. La tentative étant supprimée, le compte vit ici.
--
-- Au-delà du plafond (app.quiz.grading.max-no-verdict-failures, 3 par défaut), la tentative
-- n'est plus supprimée : elle reste en statut 'review' (« à revoir » par l'enseignant, qui peut
-- relancer la correction). Attempt.status prend donc une troisième valeur : 'pending' →
-- 'done' | 'review'. Une sandbox simplement INDISPONIBLE (démon arrêté, image absente) ne compte
-- pas : rien n'a tourné.
CREATE TABLE Grading_Failure(
   quiz_id INTEGER NOT NULL,
   user_id INTEGER NOT NULL,
   no_verdict_count INTEGER NOT NULL,
   last_failure_at TIMESTAMP NOT NULL,
   PRIMARY KEY(quiz_id, user_id),
   FOREIGN KEY(quiz_id) REFERENCES Quiz(id) ON DELETE CASCADE,
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);
