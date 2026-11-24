# Déploiement MoodIT sur un VPS Hetzner (~8 €/mois)

Guide de bout en bout : d'un compte Hetzner vide à l'app en HTTPS.
LLM = **Groq** sur le VPS (choix de coût, voir « Modèle d'IA ») ; ailleurs, un modèle local (Ollama). Sandbox de code = **conteneurs runner Docker** (#116 — nécessite un VPS avec Docker, pas un PaaS).

---

## 0. Ce qu'il te faut

- Un compte **Hetzner Cloud** (console.hetzner.cloud).
- Un **nom de domaine** (~10 €/an) — ou un sous-domaine gratuit (DuckDNS…). Requis pour le HTTPS Let's Encrypt automatique.
- Une **clé API Groq** gratuite : https://console.groq.com/keys (commence par `gsk_`).
- Un mot de passe d'application **Gmail** (ou autre SMTP) pour les emails de vérification.

---

## 1. Créer le serveur

Dans la console Hetzner → **Add Server** :

- Localisation : au choix (Nuremberg/Helsinki = moins cher ; Ashburn si public US).
- Image : **Ubuntu 24.04**.
- Type : **CAX21** (ARM Ampere, 4 vCPU / **8 Go**) ≈ 7-8 €/mois. *(x86 : CX32 équivalent.)*
- Ajouter ta **clé SSH**.
- Créer, puis noter l'**IP publique**.

> ARM (CAX) : les images des SERVICES se buildent sur place, mais **pas celles des runners**
> depuis #116 : les Dockerfile java et csharp refusent volontairement une base non amd64
> (invariant du miroir apt), et `python/requirements.txt` ne porte que des empreintes
> amd64. Pour un hôte d'exécution, prendre du x86 ;
> la prod actuelle tourne sur **x86** (CX32).

## 2. Pointer le domaine

Chez ton registrar/DNS, crée un enregistrement **A** (et **AAAA** si IPv6) :

```
moodit.example.com   A     <IP_DU_VPS>
```

Attends que ça résolve (`ping moodit.example.com`).

## 3. Préparer le serveur

```bash
ssh root@<IP_DU_VPS>

# Docker + compose plugin
curl -fsSL https://get.docker.com | sh

# Pare-feu : n'ouvrir que SSH + HTTP + HTTPS
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Récupérer le code
apt-get install -y git
git clone <URL_DE_TON_REPO> moodit && cd moodit
```

## 4. Configurer les secrets

```bash
cp deploy/env.docker.example .env.docker
nano .env.docker
```

Remplis **tous** les `CHANGER_...`. Génère les secrets forts :

```bash
openssl rand -base64 64   # à coller dans JWT_SECRET
openssl rand -base64 64   # à coller dans APP_SECURITY_PEPPER
openssl rand -base64 64   # à coller dans INTERNAL_TOKEN
```

Points clés :
- `LLM_API_KEY=gsk_...` (ta clé Groq ; voir « Modèle d'IA » pour un autre modèle).
- `FRONT_ORIGIN=https://moodit.example.com` : l'origine HTTPS réelle du site, la seule par laquelle on y accède. Le gateway refuse le WebSocket **et toutes les écritures** (connexion comprise, réponse 403) venues d'une autre origine (#234). Plusieurs valeurs possibles, séparées par des virgules ; le Caddyfile redirige `www.` vers le domaine principal pour qu'il n'y en ait qu'une.
- `SPRING_PROFILES_ACTIVE=prod`.
- `MAIL_USERNAME` / `MAIL_PASSWORD`.

Puis mets ton domaine dans le Caddyfile :

```bash
sed -i 's/moodit.example.com/TON_DOMAINE/' deploy/Caddyfile
```

## 5. Démarrer

Depuis la **racine** du repo :

```bash
# Les 10 images RUNNER (#116) : moodit-runner-{java,csharp,go,rust,c,python,node,php,bash,sqlite}.
# Conteneurs jetables lancés par execution-service pour TOUTE exécution de code étudiant
# (~8,5 Go au total ; à relancer quand docker/runners/ change).
./docker/runners/build.sh

docker compose --env-file .env.docker -f docker-compose-hetzner.yml up -d --build
```

Le premier build prend quelques minutes (6 services Java + frontend + les 10 images runner).
`db-migrate` s'arrête après avoir créé le schéma et les données de référence avec Flyway (voir « Changement de schéma »).

Suivre les logs :

```bash
docker compose --env-file .env.docker -f docker-compose-hetzner.yml logs -f gateway core-service caddy
```

## 6. Vérifier

- Ouvre **https://moodit.example.com** → l'app se charge en HTTPS (cadenas OK).
- Crée un compte → tu reçois le **code par email** → connexion.
- Ouvre un quiz de code, soumets → correction via les conteneurs runner (WebSocket met à jour le score).
- (Admin) lance une **analyse MCP** → résultat via Groq, ou repli déterministe si la clé est absente.

---

## Exploitation

| Action | Commande (depuis la racine du repo) |
|---|---|
| Voir l'état | `docker compose --env-file .env.docker -f docker-compose-hetzner.yml ps` |
| Logs d'un service | `docker compose --env-file .env.docker -f docker-compose-hetzner.yml logs -f <service>` |
| Mettre à jour le code | `./deploy/update.sh` (voir « Mettre à jour la prod ») |
| Redémarrer | `docker compose --env-file .env.docker -f docker-compose-hetzner.yml restart <service>` |
| Tout arrêter | `docker compose --env-file .env.docker -f docker-compose-hetzner.yml down` |

**Redémarrer `execution-service` pendant des corrections.** Une correction en cours au moment de
l'arrêt est perdue : sa tentative est supprimée et l'étudiant resoumet. Les corrections en file
dans core, elles, attendent : core retente la connexion pendant
`EXEC_UNREACHABLE_RETRY_MS` (2 min par défaut) avant d'abandonner, ce qui couvre un `restart`,
un `./deploy/update.sh` ou un redémarrage de l'hôte où core est prêt le premier. Au-delà de ce
délai, chaque correction en file est abandonnée à son tour (tentative supprimée) : pour un arrêt
plus long, attendre que la file soit vide (`SELECT count(*) FROM Attempt WHERE status =
'pending';` rend 0) ou prévenir les enseignants. Une sandbox indisponible n'est pas comptée dans
le plafond des échecs sans verdict (#116) : un arrêt ne fait passer aucune tentative « à revoir »,
sauf une relance d'enseignant en cours sur un quiz sans reprise (la tentative y reste `review`,
à relancer depuis l'éditeur de quiz).

### Mettre à jour la prod

Le serveur suit la branche `deploiement`, qui ne reçoit que `main` (#235) :

1. Ouvrir une PR **de `main` vers `deploiement`** (le check « source = main » refuse toute autre
   source ; la règle de branche interdit le push direct).
2. La fusionner une fois la CI verte.
3. Sur le serveur : `./deploy/update.sh` (sauvegarde, migrations Flyway, build, redémarrage,
   vérification de santé, retour à l'ancienne version du code si le build échoue). Si le
   Caddyfile chargé par Caddy diffère de celui du dépôt, le script recrée Caddy : un simple
   `restart` garderait l'ancien fichier monté (#241).
4. Si la PR modifie `deploy/update.sh` lui-même, c'est encore l'ancienne version qui s'exécute
   à ce lancement : relancer `./deploy/update.sh --force` pour appliquer la nouvelle.

### Sauvegarde de la base

```bash
docker exec moodit_postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql
```

> **Premier déploiement de #116 — l'ancien `update.sh` s'exécute.** Le script qui tire cette
> version est celui d'AVANT elle (bash garde le fichier ouvert) : il ne construit pas les images
> runner, ne pose pas `MOODIT_RUNNER_TAG`, ne passe pas `--remove-orphans`, et surveille encore
> `moodit_piston`. Sans images, toute exécution rend 502 et les tentatives sont supprimées. Et
> le clone du serveur est encore sur l'ancien commit, où `docker/runners/` n'existe pas : les
> images se construisent depuis un worktree de la NOUVELLE version. Sur le serveur, dans le clone :
>
> **Avant tout** : le contrôle préalable des harnais (section « Changement de schéma », étape 1)
> doit être sorti en 0, et l'heure de la bascule notée (`SELECT NOW()` sur la base) ; **juste
> après** le second `update.sh` vient son étape 2, `check-compiled-harnesses.py --unpublish`, avec les mêmes `--ack`.
>
> Aucun `update.sh` ne doit partir seul pendant cette procédure : si une ligne de cron le lance
> sur ce serveur (`crontab -l`), la suspendre AVANT la fusion `main → deploiement` — l'ancien
> script basculerait le code avant que les images runner existent — et la réactiver après le
> second `update.sh`.
>
> ```bash
> git fetch origin deploiement
> git worktree add --detach /tmp/moodit-runners origin/deploiement
> MOODIT_RUNNER_TAG=latest bash /tmp/moodit-runners/docker/runners/build.sh   # les 10 images, en latest
> git worktree remove /tmp/moodit-runners
> ./deploy/update.sh           # l'ANCIEN script bascule le code ; execution-service lit « latest »
> ./deploy/update.sh --force   # le NOUVEAU : images taguées par commit, --remove-orphans (Piston)
> ```

### Changement de schéma : migrations Flyway

> **Déploiement du runner (#116) — une seule forme de harnais.** Le harnais d'un langage compilé
> est un CORPS qui renvoie un **booléen**, noté par le modèle à deux processus et deux UID
> (verdict non falsifiable). C'est la forme des gabarits installés par `V5`, et la seule notée.
>
> Le format **vrai test du framework** (JUnit, NUnit, go test, cargo test, `moodit_check.h`) a
> existé dans une version intermédiaire de #116 et il est **retiré** : il compilait le harnais
> AVEC le code de l'étudiant, donc le processus qui détenait le secret était celui que l'étudiant
> contrôle. Un harnais qui en porte le marqueur est désormais refusé avec un diagnostic, avant
> toute prise de place sandbox. Le format framework n'a jamais été déployé (la production était
> à `V3`), donc aucune question n'est à convertir DE ce format. **Mais attention aux questions
> compilées antérieures à #116** : écrites pour l'époque où le harnais était compilé avec le code
> de l'étudiant, elles pouvaient échanger n'importe quel type. Le chemin booléen ne transporte
> que les entiers, flottants, booléens et chaînes (et seulement int/long/double en C et C++) :
> un harnais existant qui passe un tableau, une structure ou une collection ne compilera plus —
> `passed=false` pour chaque étudiant, sans panne visible. **Étape bloquante du déploiement :
> rejouer chaque harnais compilé contre le NOUVEAU noteur**, avec
> `deploy/check-compiled-harnesses.py`. Pas avec « Tester » sur la prod encore en place : elle
> passe toujours par Piston, qui compile le harnais avec le code de l'étudiant et accepte tous
> les types — un harnais qui cassera sous le noteur booléen y reste vert.
>
> Le script envoie le code de départ et les harnais de chaque question compilée à l'endpoint
> interne de correction, puis classe chaque question : **BLOQUANT** (le harnais ne compile pas
> contre la signature, diagnostic du compilateur à l'appui : 0 pour tout le monde), **À VÉRIFIER**
> (pas de code de départ, code de départ qui ne compile pas seul ou sans fonction aux types
> transportables, compilation du harnais expirée ou tuée, harnais qui appelle une fonction absente
> du code de départ, noteur muet ou qui refuse le format, détail non reconnu : rejouer à la main
> avec une solution) ou **OK**
> (seulement quand le détail PROUVE que le harnais a compilé et tourné ; le classement échoue
> fermé). Il sort en 1 tant qu'un quiz **publié** porte un BLOQUANT ou un À VÉRIFIER : le
> déploiement n'est pas terminé avant une sortie en 0. Pour chaque quiz publié en cause, deux
> issues : le **corriger**, ou le **fermer** (le dépublier dans l'éditeur) jusqu'à ce que son
> enseignant le corrige. Une question À VÉRIFIER se corrige en la rejouant à la main avec une
> solution (« Tester » sur une pile de CETTE version), puis en l'acquittant : `--ack <id>,<id>`
> (ids de question affichés par le script). Un BLOQUANT ne s'acquitte pas : il se corrige. Les
> questions des quiz non publiés (brouillons, quiz fermés) sont listées sans bloquer la sortie :
> aucun étudiant ne peut les soumettre, et les corriger avant d'ouvrir le quiz revient à leur
> enseignant. Le jeton interne est lu dans le conteneur et jamais affiché.
>
> **Harnais qui testent une exception.** Le noteur étant un autre programme, une exception du
> code soumis ne lui parvient pas avec son type : Java la relance en `RuntimeException`
> générique, C, C++, C#, Rust et Go s'arrêtent à l'appel refusé. Un harnais « doit lever X »
> (`catch (IllegalArgumentException e)`, `assertThrows`, `catch_unwind`, `recover()`…) écrit
> pour Piston note donc 0 à toute bonne réponse. Le rejeu du code de départ, qui ne lève rien,
> ne le montre pas : le script détecte ces harnais à leur texte et les sort À VÉRIFIER. Les
> réécrire sans exception (la fonction rend une valeur sentinelle, par exemple), puis les
> rejouer avec une solution.
>
> **Questions interprétées : noms réservés.** Le même script rejoue aussi les questions Python,
> JavaScript, TypeScript et Bash, pour un seul contrôle. Depuis #116, une fonction ou une classe
> que le harnais nomme et qui porte le nom d'une intégrée du langage (`sum`, `max`, `len` en
> Python ; `Number`, `parseInt` en JavaScript ; `test`, `factor` en Bash) est refusée avec
> « Nom réservé » : le mandataire généré à ce nom remplaçait l'intégrée dans le harnais, et un
> `abs` ajouté par l'étudiant faisait passer `abs(f(x) - 3) < 1e-9`. Le refus épargne le nom que
> le **code de départ** de la question déclare : c'est celui que l'énoncé impose (« écris
> `sum(l)` »), et il se note comme avant (#22). Core envoie ce code de départ avec chaque
> correction, et le script aussi. Une question au code de départ refusé malgré tout sort
> **BLOQUANT** (garde-fou). Une question interprétée **sans code de départ** sort À VÉRIFIER,
> comme une compilée : la rejouer avec une solution (« Tester ») ; si son énoncé impose un nom
> d'intégrée, lui ajouter un code de départ qui le déclare. Même règle quand le code de départ
> existe mais ne déclare pas ce nom (gabarit `def solution()` laissé tel quel alors que l'énoncé
> demande `sum`) : le script ne peut pas le voir, puisque le code de départ ne nomme rien de
> réservé. Chercher ces questions dans les énoncés et déclarer la fonction imposée dans leur code
> de départ.
>
> Le contrôle se fait en **deux temps**, parce que le script interroge le nouveau noteur : lancé
> seulement après la bascule, il laisse une fenêtre (plusieurs minutes par question compilée)
> pendant laquelle un quiz au harnais cassé est déjà ouvert et note 0 sur une tentative unique.
>
> **1. AVANT la mise en prod (obligatoire).** Sur une machine de dev, avec cette version
> extraite, les dix images runner construites (`docker/runners/build.sh`) et execution-service
> lancé (`./gradlew bootRun` dans `execution-service/`, `.env` local), rejouer les questions de
> la prod contre une **base jetable** chargée d'un dump **frais**, pris juste avant le contrôle.
> Pas le dernier dump d'`update.sh` (`backups/`) : il date du déploiement précédent, et ne
> contient ni les questions créées depuis ni les harnais corrigés dans l'éditeur. Pas la base de
> `docker-compose-dev.yml` non plus : son `db-migrate` y ajouterait les données de démo.
>
> Ce dump ne sort du serveur qu'avec ce dont le contrôle a besoin : le **schéma** complet, et les
> **données** de `Quiz`, `Question`, `Language`, `Test_Case` et de l'historique Flyway. Ni
> comptes, ni empreintes de mots de passe, ni forums ne quittent la prod. Sur le serveur, dans le
> clone (`.env.docker` chargé) :
>
> ```bash
> ( set -euo pipefail   # un pg_dump en échec ne doit pas laisser un dump tronqué passer pour bon
> { docker exec moodit_postgres pg_dump -U "$POSTGRES_USER" --schema-only "$POSTGRES_DB" &&
>   docker exec moodit_postgres pg_dump -U "$POSTGRES_USER" --data-only --disable-triggers \
>     -t quiz -t question -t language -t test_case -t flyway_schema_history "$POSTGRES_DB"
> } | gzip > precheck-$(date +%Y%m%d-%H%M%S).sql.gz
> )
> ```
>
> (`pg_dump` avertit d'une clé étrangère circulaire sur `language` : `--disable-triggers` est
> justement là pour la charger.) Le copier sur la machine de dev, puis l'effacer du serveur.
> Après une correction faite dans l'éditeur de la prod, reprendre un dump frais avant de
> rejouer.
>
> Sous Git Bash (Windows), préfixer les commandes `docker` qui montent un chemin par
> `MSYS_NO_PATHCONV=1`, sinon Flyway ne trouve aucune migration ; WSL ou Linux n'en ont pas
> besoin.
>
> ```bash
> # Sous-shell `set -euo pipefail` : la PREMIÈRE étape en échec arrête tout (dump illisible,
> # base qui n'est pas celle de la prod, migration refusée), et la base jetable est supprimée
> # à la sortie dans tous les cas. Le code de sortie du bloc est celui du contrôle.
> (
> set -euo pipefail
> trap 'docker rm -f moodit_precheck >/dev/null 2>&1' EXIT
> # Mêmes POSTGRES_USER / POSTGRES_DB que la prod (.env.docker), pour que le dump s'applique tel quel.
> docker run -d --name moodit_precheck -e POSTGRES_USER="$POSTGRES_USER" \
>   -e POSTGRES_PASSWORD=precheck -e POSTGRES_DB="$POSTGRES_DB" postgres:16
> # L'image redémarre une fois après son initialisation : attendre le DEUXIÈME « ready ».
> until [ "$(docker logs moodit_precheck 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do sleep 1; done
> # Dump frais pris ci-dessus sur le serveur, copié en local.
> gunzip -c precheck-AAAAMMJJ-HHMMSS.sql.gz \
>   | docker exec -i moodit_precheck psql -q -v ON_ERROR_STOP=1 -1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
> # Preuve que c'est bien le dump de la prod : sa DERNIÈRE migration appliquée est celle de la
> # prod avant cette version (3 pour #116). Une base vide, ou déjà migrée plus loin, échoue ici.
> PROD_VERSION=3
> [ "$(docker exec moodit_precheck psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
>   "SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1;")" \
>   = "$PROD_VERSION" ]
> # Migrations de CETTE version seulement (V4 et suivantes), sans la démo.
> docker run --rm --network container:moodit_precheck -v "$PWD/db:/flyway/db:ro" flyway/flyway:13.10.0 \
>   -url="jdbc:postgresql://localhost:5432/$POSTGRES_DB" -user="$POSTGRES_USER" -password=precheck \
>   -locations=filesystem:/flyway/db/migration -placeholderReplacement=false migrate
> PG_CONTAINER=moodit_precheck EXEC_URL=http://localhost:8085 INTERNAL_TOKEN=… \
>   python3 deploy/check-compiled-harnesses.py   # inventaire vide = sortie 2, jamais un faux 0
> )
> ```
>
> `EXEC_URL` est obligatoire sous Docker Desktop : l'IP d'un conteneur n'y est pas joignable
> depuis l'hôte. Le harnais C/C++ dispose de
> `<math.h>`, `<stdbool.h>`, `<stdlib.h>`, `<string.h>` et `<stdio.h>`, pas de la STL.
> Régler dans l'éditeur de la prod encore en place chaque quiz publié en cause (corriger ses
> harnais, ou le fermer), rejouer à la main les À VÉRIFIER, puis reprendre un dump frais et
> relancer le contrôle avec `--ack`, jusqu'à une sortie en 0, **avant** de lancer
> `./deploy/update.sh`. Garder la liste des `--ack` pour l'étape 2. Si ce contrôle préalable est
> impossible, fermer avant la bascule tous les quiz publiés qui portent une question de code
> compilée ou interprétée, et ne les rouvrir qu'après une sortie en 0.
>
> **2. Juste APRÈS `./deploy/update.sh`.** Rejouer contre la prod, qui est la seule référence :
>
> ```bash
> # Heure de la bascule, à noter AVANT update.sh (horloge de la base) : elle borne la fenêtre
> # ci-dessous.
> docker exec moodit_postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT NOW()::timestamp;"
> # Rejoue tout, et ferme (is_published = false) les quiz publiés qui portent un BLOQUANT ou un
> # À VÉRIFIER non acquitté, le temps de les régler dans l'éditeur. Mêmes --ack qu'à l'étape 1.
> python3 deploy/check-compiled-harnesses.py --unpublish --ack <id>,<id>
> ```
>
> Si le script ferme un quiz à cette étape, des étudiants ont pu le soumettre entre la bascule et
> la fermeture, et recevoir 0 sans faute de leur part. Lister ces tentatives (`<ids>` : les quiz
> que le script vient de fermer ; `<bascule>` : l'heure notée) :
>
> ```bash
> docker exec moodit_postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
>   "SELECT id, quiz_id, user_id, submitted_at FROM Attempt
>     WHERE quiz_id IN (<ids>) AND submitted_at >= '<bascule>' ORDER BY quiz_id, submitted_at;"
> ```
>
> Avec l'accord de l'enseignant, supprimer ces lignes (`DELETE FROM Attempt WHERE id IN (…)`,
> les réponses suivent par cascade) rend leur tentative unique aux étudiants concernés.
>
> **Retour arrière.** Un échec pendant `update.sh` déclenche son rollback automatique. Après
> coup, **ne pas** relancer `update.sh` sur un commit plus ancien : le script revient toujours à
> `origin/deploiement`, donc à la version qu'on veut quitter (et un `update.sh` en cron annule de
> même un retour fait à la main). Deux voies :
>
> - **durable** : un `git revert` de la fusion sur `main`, puis la PR `main → deploiement`
>   habituelle ; `update.sh` déploie alors l'ancienne version ;
> - **urgence**, en attendant : si un cron lance `update.sh` (`crontab -l`), suspendre cette
>   ligne (`crontab -e`), puis
>
>   ```bash
>   git reset --hard <commit d'avant la fusion>
>   docker compose --env-file .env.docker -f docker-compose-hetzner.yml up -d --build --remove-orphans
>   ```
>
>   et réactiver le cron, s'il y en a un, une fois le revert arrivé sur `deploiement`.
>
> Tant que la purge ci-dessous n'est pas faite, l'ancienne version retrouve Piston tel quel : son
> image et son volume (qui porte ses paquets) sont encore là, et le compose recrée ses conteneurs.
> `V4`, `V6` et `V7` sont additives (colonne nullable, nouvelle table, colonne à valeur par
> défaut) : l'ancien core, en `ddl-auto=validate`, démarre avec elles. `V5`, elle, **n'est pas
> réversible** : elle a réécrit les six gabarits de harnais compilés au format booléen, et
> l'ancienne version les lirait tels quels — après un retour arrière, restaurer ces gabarits depuis
> la sauvegarde que `update.sh` prend avant les migrations, ou les recréer dans l'éditeur.
>
> **La purge est le point de non-retour** : après elle, un retour arrière oblige à reconstruire
> l'image Piston et à réinstaller ses onze paquets (`piston-init`, réseau requis, plusieurs minutes
> sans exécution de code). Ne la faire qu'une fois la bascule validée —
> `check-compiled-harnesses.py` en sortie 0, puis au moins un quiz de code corrigé de bout en bout
> en prod. Le premier `update.sh` de cette version retire déjà ses conteneurs (`--remove-orphans`)
> ; l'image et le volume restent, sans gêner la nouvelle version. La purge les supprime :
>
> ```bash
> docker rm -f moodit_piston moodit_piston_init 2>/dev/null
> docker volume rm moodit_piston_data
> docker network rm moodit_sandbox 2>/dev/null   # réseau « sandbox » du compose, s'il reste
> # L'image Piston (~1,5 Go) est TAGUÉE : `prune` ne la retire pas — la nommer explicitement
> # (son nom exact : `docker images | grep -i piston`).
> docker image rm $(docker images --filter "reference=*piston*" -q)
> ```

Le schéma est versionné avec [Flyway](https://documentation.red-gate.com/flyway) (#96). Le
service one-shot `db-migrate` des fichiers compose applique, au démarrage, les versions de
`db/migration/` pas encore enregistrées dans la table `flyway_schema_history` ; les services qui
utilisent la base (auth, core, permission, mcp) ne démarrent qu'après lui. `deploy/update.sh` le
lance aussi avant le build, pour qu'une migration en échec arrête la mise à jour.

| Dossier | Contenu | Où |
|---|---|---|
| `db/migration/` | Schéma (V1), données de référence (V2 : rôles, types de forum et de question, langages), puis chaque évolution | Partout, prod comprise |
| `db/demo/` | Données de démo, un script par thème : établissements, comptes, programme et cours de base (V2.1), démo MCP (V2.2), quiz de code (V2.3), annonces (V2.4) | Dev, e2e et CI, **jamais en prod** |

#### Écrire une migration

1. Créer `db/migration/V<n>__<sujet>.sql`, `<n>` = la version suivante (ex. `V3__bio_utilisateur.sql`).
   Le SQL est appliqué tel quel, dans une transaction.
2. **Ne jamais modifier ni supprimer une migration fusionnée** : Flyway refuserait de démarrer
   (somme de contrôle différente), et le job CI `schema` bloque déjà ce cas. Une correction passe
   par une nouvelle version.
3. Si la démo doit suivre (nouvelle colonne obligatoire, nouvelles données), ajouter
   `db/demo/V<n>_1__<sujet>.sql`.
4. Vérifier en local : `docker compose -f docker-compose-dev.yml up -d` (applique les migrations
   manquantes à la base de dev), puis le job CI `schema` démarre chaque service en `validate`.

#### Appliquer en prod

Rien à faire à la main : `./deploy/update.sh` applique les nouvelles versions (après sa
sauvegarde de la base). Pour voir l'état :

```bash
docker compose --env-file .env.docker -f docker-compose-hetzner.yml run --rm --no-deps db-migrate
docker exec moodit_postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT version, description, installed_on, success FROM flyway_schema_history ORDER BY installed_rank"
```

#### Passage à Flyway d'une base existante (une seule fois)

Une base créée par l'ancien `init.sql` n'a pas d'historique Flyway. Au premier lancement,
`db-migrate` la marque à la version 2 (`FLYWAY_BASELINE_ON_MIGRATE`) sans rien rejouer : son schéma
doit donc être **exactement** celui de V1. À vérifier avant ce premier déploiement :

```bash
./deploy/check-schema.sh        # « ✓ Schéma identique à db/migration », sinon le SQL d'écart
```

En cas d'écart, corriger la base (ou ajouter une migration) avant de déployer. L'ancienne table
de suivi `schema_migrations` peut ensuite être supprimée.

#### Détecter une dérive

`./deploy/check-schema.sh` compare à tout moment la base de `moodit_postgres` (ou un dump passé
en argument) au schéma produit par `db/migration`, et affiche le SQL d'écart.

---

## Modèle d'IA (analyse MCP)

L'analyse MCP passe par une API compatible OpenAI (`/chat/completions`), configurée par trois
variables : `LLM_BASE_URL`, `LLM_MODEL` et `LLM_API_KEY` (#33).

| Où | Modèle | Pourquoi |
|---|---|---|
| Défaut (`mcp-service`, dev, tests) | Ollama local, `qwen2.5:7b-instruct` sur `http://localhost:11434/v1` | Aucune donnée du forum ne sort vers un tiers |
| `docker-compose-prod.yml` | Conteneur Ollama du réseau interne | Même raison, pour un serveur qui a la mémoire nécessaire |
| VPS (`docker-compose-hetzner.yml`) | **Groq**, `llama-3.3-70b-versatile` | **Coût** : un modèle 7B ne tient pas dans les 8 Go du VPS à côté du reste, et Groq est gratuit. Les extraits du forum, anonymisés (`ForumTextRedactor`), partent alors chez Groq |

Changer de modèle sur le VPS (par exemple vers un modèle hébergé par l'équipe) : définir
`LLM_BASE_URL` et `LLM_MODEL` dans `.env.docker`, puis `./deploy/update.sh --force`. Ces valeurs
remplacent celles du compose, et `update.sh` ne les écrase pas : `.env.docker` est hors du dépôt.

Si le modèle est injoignable ou la clé absente, `mcp-service` produit une analyse **déterministe**
à partir des vraies statistiques du cours : l'analyse aboutit toujours.

---

## Notes de coût / dimensionnement

- **~8 Go de RAM** suffisent : les 6 services Java sont plafonnés (`-Xmx`, `mem_limit`
  dans le compose). Total observé ≈ 3,5-4 Go au repos. **Pointes de notation (#116)** : chaque
  conteneur runner s'ajoute à ce total pendant qu'il tourne : la pointe vaut
  `SANDBOX_MEMORY_MB` × `EXEC_MAX_CONCURRENT` et autant de vCPU que `SANDBOX_CPUS` ×
  `EXEC_MAX_CONCURRENT`. **Valeurs effectives de ce VPS** (`docker-compose-hetzner.yml`) :
  1 Go et 1 vCPU par conteneur, 3 places → **3 Go et 3 vCPU en pointe** (les défauts 1,5 Go /
  2 vCPU visent le dev). Sur ~3,5-4 Go au repos, la marge restante est donc d'environ 1 Go :
  c'est le poste à surveiller avant d'augmenter l'une de ces bornes.
- **Groq** est gratuit (quotas généreux) ; aucune donnée LLM ne coûte de GPU. C'est la seule raison de ce choix : voir « Modèle d'IA ».
- Si tu veux **0 €/mois** : reprends exactement ce compose sur une VM
  **Oracle Cloud Always Free** (ARM 4 cœurs / 24 Go). Même fichiers, seul l'hébergeur change.
- Pour réduire la RAM : externaliser Postgres vers **Neon**/**Supabase** (offre gratuite)
  et retirer le service `postgres` du compose (mettre `POSTGRES_HOST`/`PORT` sur l'hôte managé).

## Sécurité

- Seuls les ports **80/443** sont exposés (Caddy). Tous les services applicatifs et la base
  restent sur le réseau Docker `internal`, injoignables depuis Internet.
- Le TLS est géré et renouvelé automatiquement par Caddy.
- Le code étudiant ne s'exécute QUE dans les conteneurs runner jetables (voir ci-dessous) :
  réseau coupé, limites mémoire/PID/CPU, UID dédié. Aucun service n'exécute de code non fiable
  dans son propre processus.
- Limites par exécution : temps limite par cas (défaut 3 s pour « Exécuter » et pour la notation
  des interprétés, du SQL et des vues, 10 s par cas de notation compilée — plancher de 10 s pour
  Java et C# ; configurable par question de 1 à 60 s), mémoire par conteneur
  (`SANDBOX_MEMORY_MB` — 1 Go en prod), sorties tronquées. Côté execution-service :
  `EXEC_MAX_CONCURRENT` exécutions simultanées au plus (3 en prod). Corrections et
  « Exécuter »/« Tester » ont **chacun au plus deux places** (`EXEC_MAX_CONCURRENT − 1`) : chaque
  côté en garde toujours une, même pendant une rafale de l'autre. La garantie porte sur **une**
  place, pas sur deux : quand deux « Tester » longs tiennent les deux places publiques, une
  seule correction passe ; la seconde attend `EXEC_INTERNAL_QUEUE_WAIT_MS`, puis sa tentative
  est supprimée et l'étudiant resoumet. File d'attente publique
  `EXEC_QUEUE_WAIT_MS` (15 s en prod) et `EXEC_MAX_PER_USER` requêtes en cours par utilisateur ;
  au-delà, l'interface affiche « Trop d'exécutions en cours ».
- **Runner des langages compilés (#116)** : les questions Go/Rust/C/C++/C#/Java sont notées dans
  des conteneurs jetables `moodit-runner-*` (réseau coupé, écritures étudiantes confinées aux
  tmpfs bornés `/box`, `/tmp` et `/dev/shm` — dimensionnés d'après la mémoire du conteneur et
  comptés dedans —, `SANDBOX_MEMORY_MB` de mémoire, 512 PID, `SANDBOX_CPUS`,
  `no-new-privileges` ; toutes les capacités retirées sauf le minimum du superviseur root). Dans le conteneur, le code étudiant
  tourne sous un UID dédié sans toolchain, harnais verrouillé en 700 root ; le verdict est
  fail-closed et gardé par des canaris anti-falsification (`docker/runners/README.md`).
  Capacité : une correction compilée tient une place (au plus `EXEC_MAX_CONCURRENT − 1`, 2 en
  prod, pour les corrections) pendant TOUT son conteneur ; l'attente interne des corrections (`EXEC_INTERNAL_QUEUE_WAIT_MS`, 120 s)
  absorbe un pic — au-delà, la tentative échoue et l'étudiant resoumet.
  Une correction INTERPRÉTÉE/SQL, elle, prend une place et un conteneur **par harnais** : sa
  boucle est donc bornée par un budget global (`EXEC_INTERPRETED_BUDGET_MS`, 15 min — même
  plafond que le mur d'un conteneur compilé ; 4 min pour un « Tester » public). Au-delà, les
  harnais restants ne sont pas lancés. Ce qui suit dépend de la CAUSE, sur une soumission
  d'étudiant (le « Tester » public garde toujours ses verdicts « non évalué ») :
  - **note partielle** (harnais restants « non évalué ») quand la cause est imputable au code
    soumis : solution lente qui épuise le budget par son propre travail, harnais interrompu
    (timeout, `SIGKILL`), panne d'environnement (`OSError` : disque, processus) ;
  - **502, tentative supprimée, l'étudiant resoumet** quand elle ne l'est pas : budget épuisé
    surtout par l'ATTENTE d'une place (surcharge — le temps d'attente est mesuré et retiré du
    travail), ou erreur déclarée par le superviseur. Le premier compte dans le plafond
    `QUIZ_MAX_NO_VERDICT_FAILURES` (cause « sans verdict ») : un code qui s'arrête juste sous le
    temps limite à chaque harnais pouvait sinon laisser la file transformer chaque essai en
    suppression non comptée ; un étudiant honnête pris dans la même charge est compté lui aussi,
    et au troisième sa tentative est gardée « à revoir » au lieu d'être supprimée, pour une
    relance par l'enseignant (`docker/runners/README.md`, « Mort sans verdict : journal et
    plafond »). Le second est « indisponible » et ne compte pas. Un runner mort sans verdict
    (muet ou illisible) après avoir pris en charge le code soumis compte aussi, comme une
    notation compilée « incomplète » (erreur interne du superviseur en traitant le code
    soumis). Des canaris
    incohérents (falsification) l'emportent toujours : jamais de 502 dans ce cas. Cette variable est lue par execution-service **et**
  par core-service (son miroir de délai de lecture, cf. #216) : elle vient du `.env` commun, et
  la changer pour un seul des deux ferait abandonner des corrections encore en cours.
  **Côté core, les quiz à harnais ont leur propre pool** (`AsyncConfig.quizCodeExecutor`) : autant
  de corrections en parallèle que `QUIZ_CODE_GRADING_THREADS` (3 par défaut, 2 en prod), à garder
  **égal** à `EXEC_MAX_CONCURRENT − 1`, les places accordées aux corrections — moins laisse des
  places vides, plus fait attendre des corrections dans la file d'execution-service jusqu'à leur
  abandon. Les deux se règlent dans
  `docker-compose-hetzner.yml`, l'un dans le bloc de core-service, l'autre dans celui
  d'execution-service. Les quiz SANS harnais passent par un autre pool (`quizExecutor`) et
  n'attendent jamais derrière une correction compilée. Au-delà de la file du pool de code
  (`QUIZ_CODE_GRADING_QUEUE`, 500), une soumission est refusée proprement : tentative supprimée,
  `quiz:attempt-failed` poussé, l'étudiant resoumet. Le bouton « Tester » d'un
  prof sur une question compilée pèse autant qu'une correction (même conteneur, même place).
  Une CLASSE ENTIÈRE qui soumet un quiz compilé dans la même minute (fin de créneau, examen)
  attendra longtemps ses résultats : avant ce scénario, relever **ensemble**
  `QUIZ_CODE_GRADING_THREADS` et `EXEC_MAX_CONCURRENT` à la mesure du groupe
  (`nb_étudiants × durée_correction / places`, la RAM suit — voir « coût / dimensionnement »),
  ou étaler les soumissions. Rejouage automatique et dimensionnement pour un examen : #272.
- **`strace` n'est plus utilisé, et la capacité `SYS_PTRACE` n'est plus accordée.** Elles
  servaient à tracer le code soumis pour détecter une lecture du harnais — nécessaire quand le
  harnais vivait dans un fichier qu'il pouvait ouvrir, c'est-à-dire sur le format « vraie classe
  de test du framework », retiré de #116. Le harnais est maintenant compilé dans un programme
  séparé, sous un UID séparé : il n'y a rien à surveiller, donc plus d'alerte d'exploitation de
  ce côté, et le conteneur ne peut plus tracer aucun processus.
- **Conteneurs orphelins, et accès root-équivalent à l'hôte par le socket Docker.**
  Les conteneurs runner portent l'étiquette `moodit.runner=1` : si le service est tué en pleine
  notation, son nettoyage ne s'exécute pas et le conteneur reste en « Exited » —
  `execution-service` les balaie au démarrage puis toutes les 10 min (`OrphanSweeper`), une fois
  passé un délai de grâce de 20 min qui protège les corrections en cours ; on peut les lister à la main avec
  `docker ps -a -f label=moodit.runner`. Pour lancer ces conteneurs, `execution-service` monte
  `/var/run/docker.sock` : c'est un accès
  **root-équivalent au démon de l'hôte**, et il faut en mesurer la portée — contrairement à
  l'ancien Piston (isolé sur son réseau dédié), `execution-service` est routé depuis Internet
  (`/exec/**` via le gateway) et c'est lui qui analyse le code étudiant, les harnais et la sortie
  des conteneurs. Un défaut d'exécution de code dans ce service ne se paierait donc plus par un
  conteneur sandbox compromis, mais par l'hôte entier (Postgres et Caddy compris). Les appels
  restent authentifiés (gateway, `X-Internal-Token`), `/exec/evaluate` est réservé aux éditeurs
  de quiz et le service n'expose aucune route d'administration. Le durcissement attendu (#271), à faire
  avant tout usage à plus grande échelle, **ne peut pas être un simple filtre de routes**
  (du type `tecnativa/docker-socket-proxy` réglé sur `containers/create|start|wait|logs|delete`
  et `images/inspect`) : un tel filtre ne regarde pas le CORPS de `POST /containers/create`, où
  `Privileged`, `Binds: ["/:/host"]`, `Mounts` ou `Devices` passeraient encore — il laisserait
  donc l'hôte entier à portée. Il faut l'une de ces deux mesures :
  - un intermédiaire qui **valide le corps** de chaque création et refuse tout ce qui s'écarte de
    ce que `DockerSandbox` demande : image `moodit-runner-*` seulement, `NetworkMode=none`, ni
    `Privileged`, ni `Binds`/`Mounts`/`Devices`, capacités limitées à la liste du sandbox (dont
    `SYS_RESOURCE`), `OomScoreAdj` à -1000, `no-new-privileges` présent ;
  - ou un **démon Docker rootless dédié** aux runners, dont le socket seul est monté : une
    évasion n'y donne que l'utilisateur non privilégié de ce démon. **Attention** : un démon
    rootless ne peut pas poser l'`oom_score_adj` négatif du superviseur
    (`DockerSandbox.SUPERVISOR_OOM_SCORE_ADJ`), et chaque notation répondrait 502 ; ce choix
    demande de revoir d'abord la protection du superviseur contre l'OOM
    (`docker/runners/README.md`, « Conteneur mort sans verdict »).
  - Dans tous les cas, **pas de `userns-remap`** sur le démon des runners : il ne mappe que
    65 536 UID par conteneur, et l'UID étudiant est tiré au-delà de 2²⁴ (limites par UID de
    l'hôte non partagées entre conteneurs). Vérifier : `docker info --format
    '{{.SecurityOptions}}'` ne contient ni `rootless` ni `userns`.

  En complément, faire tourner `execution-service` sous un utilisateur non root (`USER` dans son
  `Dockerfile`, `group_add` sur le GID du socket de l'hôte dans le compose) : ce GID dépend de
  l'hôte, d'où son report dans ce suivi (#271). Les images sont construites par
  `./docker/runners/build.sh` (à relancer quand `docker/runners/` change — `deploy/update.sh` le
  fait automatiquement). En prod, `update.sh` les tague par **commit** — le dernier qui touche
  `docker/runners/` ou `execution-service/`, pour qu'un déploiement qui ne les change pas ne
  redémarre pas le service en pleine correction (`MOODIT_RUNNER_TAG`,
  repris par execution-service via `SANDBOX_IMAGE_TAG` dans le compose) en plus de `latest` :
  le format d'échange avec le superviseur n'a pas de version, et un service ne tourne ainsi
  jamais avec les images d'un autre commit — ni pendant un déploiement, ni après un rollback,
  qui reconstruit celles de la version restaurée. Les tags des commits plus anciens que le
  précédent sont supprimés à chaque déploiement.
