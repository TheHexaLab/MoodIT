-- #116, S4 — Une tentative dont l'enseignant RELANCE la correction est marquée.
--
-- La relance repasse une tentative « à revoir » ('review') en 'pending'. Si la correction échoue
-- encore, elle doit revenir à revoir. Le compte d'échecs sans verdict (Grading_Failure) ne suffit
-- pas à le décider : une autre tentative de l'étudiant, corrigée entre-temps sur un quiz avec
-- reprise, le remet à zéro, et la tentative relancée était alors supprimée. Le marqueur vit donc
-- sur la tentative elle-même ; il retombe à FALSE quand la correction aboutit.
ALTER TABLE Attempt ADD COLUMN regrade BOOLEAN NOT NULL DEFAULT FALSE;
