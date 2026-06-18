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
        │                │            JwtAuthFilter                     │
        │  HTTP          │            (valide le token)                 │
        └───────────────►│                  │                          │
                         │                  ▼                          │
                         │  routes publiques     /auth/validate ───────┼──► AUTH-SERVICE (8083)
                         │  (login, register…)                         │        │
                         └─────────────────────────────────────────────┘        │
                                                                                 ▼
                                                                         PostgreSQL (5432)
```

- **Le frontend ne parle qu'au Gateway** (port 8080). Le Gateway route ensuite vers les
  microservices internes (`/auth/**` → auth-service, `/api/**` → core-service, etc.).
- **Le Gateway valide le token JWT** (`JwtAuthFilter`) avant de router vers les services.
  *(Il n'y a pas de rate limiting par IP — voir §3.)*
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
   ├─ compte bloqué (≥ 5 mdp erronés) ─► 429 TooManyRequests (verrou 15 min)
   ├─ user introuvable / mauvais mdp   ─► 401 InvalidCredentials (incrémente le compteur)
   └─ OK ─► envoie un code 2FA, renvoie AuthResponse avec token = null

POST /auth/verify-2fa  { email, code }
   ├─ ≥ 5 codes erronés ─► 429 TooManyRequests (verrou 15 min)
   └─ code correct ─► génère le JWT, stocke son hash (active_token_hash), renvoie le token
```

> **Verrous par compte (anti brute-force, sans IP).** Après **5 mots de passe** erronés, le compte
> est bloqué **15 min** (`failed_login_attempts` / `login_locked_until`). De même, après **5 codes
> 2FA** erronés (`verification_attempts` / `verification_locked_until`). Le comptage est **par
> compte** : il résiste au changement d'IP et ne nécessite pas de conserver l'IP.

### 2.3 Renvoi de code
`POST /auth/resend-code { email, mode }` régénère et renvoie un code, pour l'inscription
(`mode: "email"`) ou la 2FA (`mode: "2fa"`), en respectant le cooldown et le plafond.

---

## 3. Mécanismes anti-flooding / anti brute-force

| Couche | Où | Protège contre |
|---|---|---|
| **Table de staging** `pending_registration` | auth-service | Pollution de `user_` par des comptes/usernames bidons |
| **Throttle par email** (cooldown 60 s + plafond 5 renvois) | auth-service (`AuthService`) | Bombardement de courriels vers **une adresse ciblée** |
| **Verrou de connexion par compte** (5 mdp erronés → blocage 15 min) | auth-service (`AuthService`) | Brute-force du **mot de passe** d'un compte |
| **Verrou 2FA par compte** (5 codes erronés → blocage 15 min) | auth-service (`AuthService`) | Brute-force du **code à 6 chiffres** |

> **Pas de rate limit par IP.** La spécification du projet interdit de conserver l'IP en mémoire :
> le filtre `RateLimitFilter` (gateway) est donc **désactivé** (commenté). Les verrous ci-dessus
> comptent **par compte**, ce qui résiste au changement d'IP — au prix de ne pas voir un attaquant
> qui balaie *plein* de comptes (spraying) ; un CAPTCHA serait le complément pour ce cas.

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
| `AuthService` | **Cœur du système.** register, login, verifyEmail, verify2FA, validate, resendCode + helpers (`generateCode`, `extractDomain`, `normalizeEmail`). Applique cooldown, plafonds, **verrous par compte** (login + 2FA), normalisation d'email, contrôle de domaine. |
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
| `GatewayConfig` | Enregistre les filtres servlet. Seul `JwtAuthFilter` est actif (l'enregistrement de `RateLimitFilter` est commenté). |
| `RateLimitFilter` | **Désactivé (commenté).** Faisait du rate limiting par IP (Bucket4j + Caffeine) ; retiré car la spécification interdit de conserver l'IP en mémoire. Remplacé par les verrous par compte (auth-service). |
| `JwtAuthFilter` | Laisse passer les routes publiques ; sinon valide le JWT localement puis délègue à `/auth/validate` ; injecte `X-User-Email` pour les services en aval ; fail-closed (503) si l'auth-service est injoignable. |
| `WrappedRequest` | Wrapper de requête qui ajoute le header `X-User-Email` (l'email extrait du token). |
| `SecurityConfig` | Spring Security du Gateway (stateless, CSRF off). |

---

## 5. Base de données

Le schéma est géré par **`init.sql`** (monté dans Postgres), **pas par Hibernate**
(voir §7). Tables clés de l'authentification :

- **`user_`** : comptes confirmés. Une ligne n'y existe qu'après vérification de l'email
  (pas de flag `verified_email` : la présence dans cette table = email vérifié). Colonnes
  notables : `email` (unique), `password_hash`, `active_token_hash` ;
  **2FA** : `verification_code` / `verification_code_expires_at` / `verification_attempts` /
  `last_code_sent_at` / `verification_locked_until` ;
  **verrou de connexion** : `failed_login_attempts` / `login_locked_until`.
- **`pending_registration`** : inscriptions en attente. Mêmes infos de base + `resend_count`,
  `verification_attempts`, `last_code_sent_at` (anti-bombing).
- **`establishment`** : `domain_email` (unique) = domaines autorisés à s'inscrire.

> ⚠️ Les emails sont stockés **en minuscules** (normalisés) → l'authentification est
> **insensible à la casse**.

---

## 6. Tests

Lancer une suite : `./gradlew test` (depuis `auth-service/` ou `gateway/`).
Rapport HTML en cas d'échec : `build/reports/tests/test/index.html`.

### Lancer toute la batterie (backend + frontend)

Depuis la **racine du projet**. Les 3 services backend sont des modules Gradle indépendants ;
le frontend n'a pas de tests unitaires (seulement `lint` + `build`).

**macOS / Linux (bash) :**
```bash
(cd auth-service && ./gradlew test)
(cd gateway      && ./gradlew test)
(cd core-service && ./gradlew test)
(cd frontend     && npm run lint)
```

**Windows (PowerShell) :**
```powershell
cd auth-service; .\gradlew.bat test; cd ..
cd gateway;      .\gradlew.bat test; cd ..
cd core-service; .\gradlew.bat test; cd ..
cd frontend;     npm.cmd run lint;   cd ..
```

> Sous PowerShell, utilise `.\gradlew.bat` et `npm.cmd` (le wrapper `npm.ps1` peut être bloqué
> par la politique d'exécution ; sinon : `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).
> `npm run build` (`tsc -b`) reste rouge sur des erreurs TS pré-existantes hors auth/gateway.

### `auth-service`
| Classe | Type | Ce qu'elle vérifie |
|---|---|---|
| `AuthServiceTest` | Unitaire (Mockito) | register (normalisation casse, email/username déjà pris, domaine refusé, cooldown, plafond renvoi), login (introuvable, mauvais mdp, succès+2FA, **verrou après 5 mdp erronés**, **compte bloqué → 429 sans tester le mdp**), verifyEmail (succès→migration vers `user_`, mauvais code+compteur, plafond, expiration), verify2FA (succès+token, mauvais code, **plafond→verrou 15 min**). |
| `JwtServiceTest` | Unitaire | round-trip génération/validation, rejet d'un token invalide, `getHashCount` ∈ [2,5], hash déterministe. |
| `AuthControllerTest` | Intégration web-slice (`@WebMvcTest`) | mapping exception → statut HTTP : 200, 400 (validation), 409, 403, 401, 429. |
| `AuthServiceApplicationTests` | Contexte | `contextLoads` (démarrage du contexte Spring). **Nécessite un Postgres en marche.** |

### `gateway`
| Classe | Type | Ce qu'elle vérifie |
|---|---|---|
| ~~`RateLimitFilterTest`~~ | — | **Désactivé (commenté)** en même temps que `RateLimitFilter` (plus de rate limit par IP). |
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

1. **Le Gateway dépend de l'auth-service** pour valider chaque requête authentifiée (appel
   `/auth/validate`). Si l'auth-service est down, le Gateway refuse tout (fail-closed, 503).
2. **Secrets par défaut** (`dev-...-change-in-production`) à remplacer impérativement en production.
3. **`AuthService.hashToken`** utilise un schéma de hachage maison ; fonctionnel mais à
   reconsidérer pour un usage production (token opaque aléatoire, p. ex.).
