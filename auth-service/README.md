# 🔐 Authentification MoodIT — `auth-service` & `gateway`

Documentation technique du système d'authentification de MoodIT : comment il fonctionne,
à quoi sert chaque classe, ce que vérifient les tests, et les pièges à connaître.

> Ce document couvre **deux services** : `auth-service` (logique d'authentification + base de
> données) et `gateway` (point d'entrée unique qui valide les tokens et protège les routes).

---

## 1. Vue d'ensemble

```
                         ┌─────────────────────────────────────────────┐
   Navigateur            │                  GATEWAY (8080)              │
   (frontend 5173)       │                                             │
        │                │  RateLimitFilter ──► JwtAuthFilter           │
        │  HTTP          │   (quotas/IP)         (valide le token)      │
        └───────────────►│        │                   │                │
                         │        ▼                   ▼                │
                         │  routes publiques     /auth/validate ───────┼──► AUTH-SERVICE (8083)
                         │  (login, register…)                         │        │
                         └─────────────────────────────────────────────┘        │
                                                                                 ▼
                                                                         PostgreSQL (5432)
```

- **Le frontend ne parle qu'au Gateway** (port 8080). Le Gateway route ensuite vers les
  microservices internes (`/auth/**` → auth-service, `/api/**` → core-service, etc.).
- **Tout passe par deux filtres** au Gateway : d'abord le **rate limiting par IP**, puis la
  **validation du token JWT**.
- **L'auth-service** porte toute la logique métier (inscription, vérification, login, 2FA) et
  est le seul à accéder à la table des utilisateurs.

### Principe de sécurité clé : double validation du token
Le Gateway valide le JWT **localement** (signature + expiration) pour un rejet rapide, puis
demande à l'auth-service via `POST /auth/validate` si ce token est encore le **token actif**
en base (`active_token_hash`). Cela permet la **révocation / session unique** : un ancien token
(remplacé par un nouveau login) est refusé même si sa signature est encore valide.

---

## 2. Les parcours (flows)

### 2.1 Inscription → vérification d'email
L'inscription **n'écrit pas** directement dans la table des comptes. Les données vont d'abord
dans une **table de staging** (`pending_registration`). Le compte n'entre dans `user_` qu'une
fois le code reçu par courriel confirmé. Cela évite de polluer la table des comptes (anti-flooding).

```
POST /auth/register
   └─► insère dans pending_registration (mot de passe déjà hashé)
   └─► envoie un code à 6 chiffres par courriel (expire en 15 min)

POST /auth/verify-email  { email, code }
   ├─ code correct  ─► crée la ligne dans user_ (verified=true) + SUPPRIME le pending
   └─ code erroné   ─► incrémente verification_attempts ; au-delà de 5, le code est invalidé
```

### 2.2 Connexion → double authentification (2FA)
Le login **ne renvoie pas tout de suite de token**. Mot de passe validé → un code 2FA est
envoyé par courriel ; le token n'est émis qu'après `verify-2fa`.

```
POST /auth/login  { email, password }
   ├─ user introuvable / mauvais mdp ─► 401 InvalidCredentials
   └─ OK ─► envoie un code 2FA, renvoie AuthResponse avec token = null

POST /auth/verify-2fa  { email, code }
   └─ code correct ─► génère le JWT, stocke son hash (active_token_hash), renvoie le token
```

### 2.3 Renvoi de code
`POST /auth/resend-code { email, mode }` régénère et renvoie un code, pour l'inscription
(`mode: "email"`) ou la 2FA (`mode: "2fa"`), en respectant le cooldown et le plafond.

---

## 3. Mécanismes anti-flooding (3 couches)

| Couche | Où | Protège contre |
|---|---|---|
| **Table de staging** `pending_registration` | auth-service | Pollution de `user_` par des comptes/usernames bidons |
| **Throttle par email** (cooldown 60 s + plafond 5 renvois) | auth-service (`AuthService`) | Bombardement de courriels vers **une adresse ciblée** |
| **Rate limit par IP** (5/min sur register & verify, 10/min sur login) | gateway (`RateLimitFilter`) | Un attaquant qui balaie **plein d'adresses** depuis une origine |

Couches complémentaires : un `CleanupJob` purge les inscriptions en attente expirées, et un
contrôle de domaine restreint l'inscription aux établissements autorisés.

---

## 4. Rôle de chaque classe

### `auth-service`

#### Controllers (`controller/`)
| Classe | Rôle |
|---|---|
| `AuthController` | Expose les endpoints publics : `/register`, `/login`, `/validate`, `/verify-email`, `/verify-2fa`, `/resend-code`. |
| `AuthDevController` | Endpoint **réservé au dev** (`@Profile("dev")`) : `/auth/verify/{username}` promeut une inscription en attente sans passer par le courriel. **Inexistant en production.** |

#### DTO (`dto/`) — objets de transfert (entrées/sorties HTTP)
| Classe | Rôle |
|---|---|
| `RegisterRequest` | Corps de `/register` avec validation (`@NotBlank`, `@Email`, `@Size`). |
| `LoginRequest` | Corps de `/login` (email + mot de passe). |
| `AuthResponse` | Réponse renvoyée au client (token + infos profil). |

#### Modèle (`model/`) — entités JPA (= tables)
| Classe | Table | Rôle |
|---|---|---|
| `User` | `user_` | Compte **confirmé**. Contient le hash du mot de passe, le code de vérification (pour la 2FA), `active_token_hash`, etc. |
| `PendingRegistration` | `pending_registration` | Inscription **en attente** de confirmation d'email (staging). |
| `Establishment` | `establishment` | Domaines courriel autorisés à s'inscrire (lecture seule ici). |

#### Repositories (`repository/`) — accès BD (Spring Data JPA)
| Classe | Rôle |
|---|---|
| `UserRepository` | Recherche/existence par email et username sur `user_`. |
| `PendingRegistrationRepository` | Idem sur le staging + `deleteExpired` (purge). |
| `EstablishmentRepository` | `existsByDomainEmail` pour le contrôle de domaine. |

#### Services (`service/`) — logique métier
| Classe | Rôle |
|---|---|
| `AuthService` | **Cœur du système.** register, login, verifyEmail, verify2FA, validate, resendCode + helpers (`generateCode`, `extractDomain`, `normalizeEmail`). Applique cooldown, plafonds, normalisation d'email, contrôle de domaine. |
| `JwtService` | Génère/valide les JWT (signature HS256), extrait l'email, calcule le hash du token actif. |
| `EmailService` | Envoie les courriels (code de vérification, code 2FA) via SMTP. |
| `CleanupJob` | Tâche planifiée (`@Scheduled`, toutes les heures) qui supprime les `pending_registration` expirés. |

#### Exceptions (`exception/`) — mappées en codes HTTP par `GlobalExceptionHandler`
| Exception | Statut HTTP | Sens |
|---|---|---|
| `EmailAlreadyUsedException` | 409 | Email déjà pris |
| `UsernameAlreadyUsedException` | 409 | Username déjà pris |
| `InvalidCredentialsException` | 401 | Email ou mot de passe invalide |
| `InvalidVerificationCodeException` | 400 | Code invalide/expiré |
| `TooManyRequestsException` | 429 | Cooldown/plafond dépassé |
| `DomainNotAllowedException` | 403 | Domaine hors établissements autorisés |
| (validation `@Valid`) | 400 | Champs invalides (géré dans le handler) |

#### Config (`config/`)
| Classe | Rôle |
|---|---|
| `SecurityConfig` | Spring Security : routes publiques (`permitAll`), reste authentifié ; définit le `BCryptPasswordEncoder`. |
| `SwaggerConfig` | Configuration OpenAPI/Swagger. |

### `gateway`

| Classe | Rôle |
|---|---|
| `GatewayApplication` | Point d'entrée Spring Boot + endpoint de test `/gateway/test`. |
| `GatewayConfig` | Enregistre les filtres servlet dans l'ordre : `RateLimitFilter` (order 0) **avant** `JwtAuthFilter` (order 1). |
| `RateLimitFilter` | Rate limiting par IP (token-bucket Bucket4j + cache Caffeine). Quotas différenciés par groupe de routes. Renvoie 429 + `Retry-After`. |
| `JwtAuthFilter` | Laisse passer les routes publiques ; sinon valide le JWT localement puis délègue à `/auth/validate` ; injecte `X-User-Email` pour les services en aval ; fail-closed (503) si l'auth-service est injoignable. |
| `WrappedRequest` | Wrapper de requête qui ajoute le header `X-User-Email` (l'email extrait du token). |
| `SecurityConfig` | Spring Security du Gateway (stateless, CSRF off). |

---

## 5. Base de données

Le schéma est géré par **`init.sql`** (monté dans Postgres), **pas par Hibernate**
(voir §7). Tables clés de l'authentification :

- **`user_`** : comptes confirmés. Une ligne n'y existe qu'après vérification de l'email
  (pas de flag `verified_email` : la présence dans cette table = email vérifié). Colonnes
  notables : `email` (unique), `password_hash`, `verification_code` /
  `verification_code_expires_at` / `verification_attempts` / `last_code_sent_at`
  (pour la 2FA), `active_token_hash`.
- **`pending_registration`** : inscriptions en attente. Mêmes infos de base + `resend_count`,
  `verification_attempts`, `last_code_sent_at` (anti-bombing).
- **`establishment`** : `domain_email` (unique) = domaines autorisés à s'inscrire.

> ⚠️ Les emails sont stockés **en minuscules** (normalisés) → l'authentification est
> **insensible à la casse**.

---

## 6. Tests

Lancer : `./gradlew test` (depuis `auth-service/` ou `gateway/`).
Rapport HTML : `build/reports/tests/test/index.html`.

### `auth-service`
| Classe | Type | Ce qu'elle vérifie |
|---|---|---|
| `AuthServiceTest` | Unitaire (Mockito) | register (normalisation casse, email/username déjà pris, domaine refusé, cooldown, plafond renvoi), login (introuvable, non vérifié, mauvais mdp, succès+2FA), verifyEmail (succès→migration vers `user_`, mauvais code+compteur, plafond→invalidation du code, expiration), verify2FA (succès+token, mauvais code). |
| `JwtServiceTest` | Unitaire | round-trip génération/validation, rejet d'un token invalide, `getHashCount` ∈ [2,5], hash déterministe. |
| `AuthControllerTest` | Intégration web-slice (`@WebMvcTest`) | mapping exception → statut HTTP : 200, 400 (validation), 409, 403, 401, 429. |
| `AuthServiceApplicationTests` | Contexte | `contextLoads` (démarrage du contexte Spring). **Nécessite un Postgres en marche.** |

### `gateway`
| Classe | Type | Ce qu'elle vérifie |
|---|---|---|
| `RateLimitFilterTest` | Unitaire (servlet mock) | route non limitée passe toujours ; register/verify/resend bloqués après 5 ; login après 10 ; comptage par IP indépendant ; en-tête `Retry-After` sur le 429. |
| `JwtAuthFilterTest` | Unitaire (`RestClient` mocké) | route publique sans token ; token absent → 401 ; signature invalide → 401 ; token valide+actif → passe et injecte `X-User-Email` ; token révoqué → 401 ; auth-service injoignable → 503. |
| `GatewayApplicationTests` | Contexte | `contextLoads`. |

> Tous les tests ajoutés sont **autonomes** (aucune BD ni SMTP requis), sauf les `contextLoads`
> préexistants côté auth-service qui exigent un Postgres.

---

## 7. Configuration & démarrage

- **Ports** (configurables via `.env`) : auth-service `8083`, gateway `8080`, Postgres `5432`.
- **Secrets** (dans `.env`) : `JWT_SECRET` (doit être **identique** entre gateway et auth-service,
  ≥ 32 octets pour HS256) et `APP_SECURITY_PEPPER` (ajouté au mot de passe avant le hash BCrypt).
- **SMTP** : `MAIL_USERNAME` / `MAIL_PASSWORD` requis pour l'envoi réel des codes ; sinon
  `/register` échouera à l'envoi du courriel.
- **Lancer** : `docker compose -f docker-compose-dev.yml up` (Postgres + pgAdmin), puis
  démarrer `auth-service` puis `gateway` (IDE ou `./gradlew bootRun`).

---

## 8. Pièges à connaître (limites actuelles)

1. **Le schéma vient de `init.sql`, pas d'Hibernate.** Les `application.properties` utilisent une
   syntaxe `%dev.`/`%prod.` (style Quarkus) **non interprétée par Spring** → `ddl-auto` reste à
   `none`. Toute nouvelle entité/colonne doit être ajoutée **à la main dans `init.sql`**.
   `init.sql` ne s'exécute **que sur un volume vierge** (`down -v` pour repartir à neuf).
2. **Rate limiter en mémoire = par instance.** Si le Gateway est répliqué, chaque instance a ses
   propres compteurs. Pour une limite globale partagée, il faudrait Redis.
3. **Le Gateway dépend de l'auth-service** pour valider chaque requête authentifiée (appel
   `/auth/validate`). Si l'auth-service est down, le Gateway refuse tout (fail-closed, 503).
4. **Secrets par défaut** (`dev-...-change-in-production`) à remplacer impérativement en production.
5. **`AuthService.hashToken`** utilise un schéma de hachage maison ; fonctionnel mais à
   reconsidérer pour un usage production (token opaque aléatoire, p. ex.).
