<!--
Titre de la PR : commit conventionnel, ex. « feat(core): système d'amis » ou « fix(frontend): … ».
Le type (feat, fix, refactor, docs, test, chore) et les labels de service et de taille sont posés
automatiquement d'après le titre et les fichiers touchés : rien à cocher pour ça.
Les commentaires HTML comme celui-ci n'apparaissent pas dans la PR publiée.
-->

<!-- Lier l'issue : « Closes #43 » la ferme à la fusion dans main ; « Refs #43 » la mentionne seulement. -->
Closes #

## Résumé

<!-- Quoi et pourquoi, en deux ou trois phrases. -->

## Type de changement

<!--
Cocher tout ce qui s'applique. Le label de type est posé d'après le titre (préfixe entre
parenthèses) ; ces cases servent au relecteur à voir d'un coup d'œil la portée de la PR.
-->
- [ ] Nouvelle fonctionnalité (`feat`)
- [ ] Correction de bogue (`fix`)
- [ ] Correctif de sécurité (`fix`) : faille, contrôle d'accès, secret exposé
- [ ] Refactoring sans changement de comportement (`refactor`)
- [ ] Performance (`perf`)
- [ ] Tests seulement (`test`)
- [ ] Documentation : README, wiki, `CLAUDE.md`, commentaires (`docs`)
- [ ] CI, outillage ou build (`ci`, `build`)
- [ ] Dépendances : montée de version, ajout, retrait (`chore`)
- [ ] Style ou formatage, sans effet sur le code (`style`)
- [ ] Schéma de base de données : `init.sql` et migration (`feat` ou `fix`)
- [ ] Infrastructure ou déploiement : Docker, compose, serveur (`chore`)
- [ ] **Changement incompatible** : route, contrat d'API ou comportement dont dépend un autre service ou le frontend (`!` dans le titre, ex. `feat(core)!: …`)

## Changements de comportement

<!--
Ce qui change pour un utilisateur ou pour un autre service : route ajoutée ou modifiée, règle
d'autorisation, schéma de BD, contrat d'API, comportement visible dans l'interface.
Une ligne par changement, avec le test qui le prouve. Écrire « Aucun » si c'est le cas.
-->

## Comment tester

<!-- Commandes, parcours dans l'app, comptes à utiliser. -->

## Captures d'écran

<!-- Si l'interface change : avant / après. Supprimer la section sinon. -->

## Définition de terminé

- [ ] L'issue est liée (`Closes #…` ou `Refs #…`) et ses critères d'acceptation sont remplis
- [ ] Code documenté : commentaires en français, `CLAUDE.md` ou wiki mis à jour si une règle change
- [ ] Tests ajoutés ou mis à jour, et CI verte : tests, couverture au-dessus du seuil, Playwright
- [ ] Route d'écriture ajoutée ou modifiée : règle dans `permission-service` et manifestes de routes à jour
- [ ] Changement de schéma : `init.sql` **et** une migration idempotente dans `migrations/`
- [ ] Aucun secret, jeton ou fichier `.env` dans le diff
- [ ] Aucun conflit non résolu

## Utilisation de l'IA

<!-- Politique du README : l'IA est permise si le code est compris et testé, et la PR porte le label. -->
- [ ] Du code de cette PR a été généré ou assisté par IA : le label `vibe-coded` est posé, et je comprends tout le code.

## Notes pour les reviewers

<!--
Où regarder en priorité (fichiers et fonctions à risque), choix discutables, éléments qui ont
l'air suspects mais sont voulus. Utile aussi pour une revue assistée par IA.
-->
