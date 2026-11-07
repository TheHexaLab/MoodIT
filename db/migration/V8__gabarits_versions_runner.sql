-- #116 — Retrait de Piston : les gabarits annoncent les versions des images RUNNER.
--
-- L'en-tête « Sandbox : … » des gabarits décrit l'environnement réel d'exécution (audité, pas
-- deviné). Les runtimes viennent désormais des images moodit-runner-* (docker/runners/) :
-- Node 22 (images node:22) remplace le Node 20 de Piston pour JavaScript et TypeScript.
-- V2 étant fusionnée, on corrige par UPDATE (forward-only).
UPDATE Language SET start_code_template =
    replace(start_code_template, 'Node.js 20', 'Node.js 22')
WHERE name IN ('JavaScript', 'TypeScript');
