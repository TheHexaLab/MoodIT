-- ============================================================================
--  V3 — Retrait des données du prototype vocal (#235)
-- ============================================================================
-- La branche `deploiement` (la prod) portait le prototype vocal : un type de forum 'Voice' et un
-- salon vocal par cours. Le vocal est retiré de `deploiement` (il reste sur
-- feature/voice-chat-prototype) : ces lignes n'ont plus de code pour les afficher.
--
-- Sans effet sur une base créée par les migrations de main (aucun type 'Voice'). Un salon vocal
-- n'a pas de posts ; s'il en avait, ils partiraient avec lui (Post.forum_id ON DELETE CASCADE).
-- Au retour du vocal sur main, une nouvelle migration recréera le type et les salons.

DELETE FROM Forum
WHERE f_type_id IN (SELECT id FROM F_Type WHERE name = 'Voice');

DELETE FROM F_Type
WHERE name = 'Voice';
