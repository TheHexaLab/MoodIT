package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/**
 * GARDE-FOU de couverture des routes. Croise les routes MUTANTES (POST/PUT/PATCH/DELETE) des
 * services core/mcp/execution avec les règles de {@link PermissionService#buildRules()}, et échoue
 * si une route n'a PAS de règle.
 *
 * <p>Pourquoi : le moteur est en default-DENY sur les écritures. Une route mutante SANS règle est
 * donc refusée (403) — pas un trou de sécurité, mais une FONCTION cassée silencieusement. Ce test
 * force une décision EXPLICITE (ajouter une règle — un vrai gate, ou {@code -> true} pour ouvrir)
 * dès qu'un contrôleur mutant apparaît.
 *
 * <p>Source des routes : les MANIFESTES {@code <service>/src/test/resources/mutating-routes.txt},
 * générés par INTROSPECTION SPRING dans chaque service (voir {@code MutatingRouteManifestTest}).
 * Les builds Gradle étant indépendants (les classes core ne sont pas sur ce classpath), le fichier
 * versionné sert de contrat ; sa fraîcheur est garantie côté service (le test de manifeste échoue
 * s'il dérive des vraies routes). Ici on n'utilise QUE les vraies règles ({@link
 * PermissionService#ruleSignatures()}) — aucune duplication. Variables de path normalisées
 * ({@code {x}} → {@code {}}) : AntPathMatcher matche par position, pas par nom.
 */
class RouteCoverageTest {

  /**
   * Routes mutantes que l'on choisit DÉLIBÉRÉMENT de laisser sans règle (donc refusées par le
   * default-deny). Vide aujourd'hui. Y ajouter "VERB /chemin/normalisé" — avec un commentaire
   * justifiant — plutôt qu'une règle {@code -> false} sans intérêt.
   */
  private static final Set<String> INTENTIONALLY_UNGUARDED = Set.of();

  /** Emplacement des manifestes (relatif à la racine du repo). */
  private static final List<String> MANIFESTS =
      List.of(
          "core-service/src/test/resources/mutating-routes.txt",
          "mcp-service/src/test/resources/mutating-routes.txt",
          "execution-service/src/test/resources/mutating-routes.txt");

  @Test
  void everyMutatingRouteHasARule() {
    Path repoRoot = findRepoRoot();
    assertThat(repoRoot)
        .as("racine du repo (dossier contenant core-service ET permission-service) introuvable")
        .isNotNull();

    List<String> routes =
        MANIFESTS.stream()
            .flatMap(rel -> readManifest(repoRoot.resolve(rel)).stream())
            .map(RouteCoverageTest::normalizeSignature)
            .distinct()
            .toList();

    // Garde-fou du garde-fou : manifestes vides/absents = contrat cassé.
    assertThat(routes)
        .as("aucune route dans les manifestes — les MutatingRouteManifestTest ont-ils tourné ?")
        .isNotEmpty();

    Set<String> ruleSet =
        new PermissionService(null, null, new ObjectMapper())
            .ruleSignatures().stream()
                .map(RouteCoverageTest::normalizeSignature)
                .collect(Collectors.toSet());

    List<String> uncovered =
        routes.stream()
            .filter(sig -> !ruleSet.contains(sig))
            .filter(sig -> !INTENTIONALLY_UNGUARDED.contains(sig))
            .sorted()
            .toList();

    assertThat(uncovered)
        .as(
            "Routes MUTANTES SANS règle de permission (default-deny → 403 silencieux). Ajoute une "
                + "règle dans PermissionService.buildRules() — un vrai gate, ou (user,vars,body) -> "
                + "true pour l'ouvrir — ou ajoute la route à INTENTIONALLY_UNGUARDED pour la fermer.")
        .isEmpty();
  }

  private static List<String> readManifest(Path manifest) {
    if (!Files.isRegularFile(manifest)) {
      throw new IllegalStateException(
          "Manifeste introuvable: " + manifest + " — lance le MutatingRouteManifestTest du service.");
    }
    try {
      return Files.readAllLines(manifest).stream()
          .map(String::trim)
          .filter(l -> !l.isBlank() && !l.startsWith("#"))
          .toList();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** "VERB /chemin" → "VERB /chemin" avec {var} → {} (nom de variable indifférent). */
  private static String normalizeSignature(String sig) {
    int i = sig.indexOf(' ');
    String method = sig.substring(0, i).toUpperCase(java.util.Locale.ROOT);
    String path = sig.substring(i + 1).replaceAll("\\{[^}]+}", "{}");
    return method + " " + path;
  }

  /** Remonte depuis le répertoire courant jusqu'au dossier contenant les modules. */
  private static Path findRepoRoot() {
    Path dir = Paths.get("").toAbsolutePath();
    while (dir != null
        && !(Files.isDirectory(dir.resolve("core-service"))
            && Files.isDirectory(dir.resolve("permission-service")))) {
      dir = dir.getParent();
    }
    return dir;
  }
}
