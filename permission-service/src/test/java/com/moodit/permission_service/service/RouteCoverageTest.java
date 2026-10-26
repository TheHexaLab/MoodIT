package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.http.server.PathContainer;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;
import tools.jackson.databind.ObjectMapper;

/**
 * GARDE-FOU de couverture des routes. Croise les routes (écritures et lectures) des services
 * core/mcp/execution avec les règles de {@link PermissionService#buildRules()}, et échoue si une
 * route n'a PAS de règle, ou si la règle qui décide n'est pas celle de la route que Spring sert.
 *
 * <p>Pourquoi : le moteur est en default-DENY, en lecture comme en écriture (#111). Une route SANS
 * règle est donc refusée (403) : pas un trou de sécurité, mais une FONCTION cassée silencieusement.
 * Ce test force une décision EXPLICITE (ajouter une règle — un vrai gate, ou {@code -> true} pour
 * ouvrir) dès qu'un contrôleur apparaît.
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

  /** Emplacement des manifestes MUTANTS (relatif à la racine du repo). */
  private static final List<String> MANIFESTS =
      List.of(
          "core-service/src/test/resources/mutating-routes.txt",
          "mcp-service/src/test/resources/mutating-routes.txt",
          "execution-service/src/test/resources/mutating-routes.txt");

  /** Emplacement des manifestes de LECTURE (GET). */
  private static final List<String> READABLE_MANIFESTS =
      List.of(
          "core-service/src/test/resources/readable-routes.txt",
          "mcp-service/src/test/resources/readable-routes.txt",
          "execution-service/src/test/resources/readable-routes.txt");

  /**
   * Manifestes par SERVICE : chaque service route ses requêtes seul, parmi SES routes. La
   * comparaison avec le choix de Spring se fait donc service par service.
   */
  private static final Map<String, List<String>> SERVICE_MANIFESTS =
      Map.of(
          "core-service",
          List.of(MANIFESTS.get(0), READABLE_MANIFESTS.get(0)),
          "mcp-service",
          List.of(MANIFESTS.get(1), READABLE_MANIFESTS.get(1)),
          "execution-service",
          List.of(MANIFESTS.get(2), READABLE_MANIFESTS.get(2)));

  /**
   * Valeurs d'essai des variables de chemin, telles qu'envoyées sur le fil : un id numérique, et un
   * texte non ASCII encodé (« élève »), le seul encodage que le gateway laisse passer (#111).
   */
  private static final List<String> SAMPLE_VALUES = List.of("7", "%C3%A9l%C3%A8ve");

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

  @Test
  void everyReadableRouteHasARule() {
    Path repoRoot = findRepoRoot();
    assertThat(repoRoot)
        .as("racine du repo (dossier contenant core-service ET permission-service) introuvable")
        .isNotNull();

    List<String> reads =
        READABLE_MANIFESTS.stream()
            .flatMap(rel -> readManifest(repoRoot.resolve(rel)).stream())
            .map(RouteCoverageTest::normalizeSignature)
            .distinct()
            .toList();

    // Garde-fou du garde-fou : au moins core + mcp exposent des GET.
    assertThat(reads)
        .as("aucune route GET dans les manifestes — les readableManifest tests ont-ils tourné ?")
        .isNotEmpty();

    Set<String> ruleSet =
        new PermissionService(null, null, new ObjectMapper())
            .ruleSignatures().stream()
                .map(RouteCoverageTest::normalizeSignature)
                .collect(Collectors.toSet());

    List<String> unclassified =
        reads.stream()
            .filter(sig -> !ruleSet.contains(sig))
            .sorted()
            .toList();

    assertThat(unclassified)
        .as(
            "GET SANS règle de permission (default-deny → 403). Ajoute une règle dans "
                + "PermissionService.buildRules() : un vrai gate si la donnée est SENSIBLE "
                + "(appartenance / rôle), sinon (user,vars,body) -> true dans le bloc des lectures "
                + "ouvertes (catalogue / référence / self).")
        .isEmpty();
  }

  /**
   * La décision d'autorisation porte sur la MÊME route que celle que le service exécute (#111). Pour
   * chaque route des manifestes, on fabrique un chemin concret (brut, tel que transmis par le
   * gateway), on laisse le moteur de Spring MVC ({@link PathPatternParser}, avec son ordre de
   * spécificité) choisir la route parmi celles du service, et on exige que {@link
   * PermissionService#matchingRuleSignature} retienne une règle de même motif. Un écart (règle
   * générique placée avant une route plus précise, décodage différent…) appliquerait la règle d'une
   * autre route que celle servie.
   */
  @Test
  void permissionRuleMatchesTheRouteSpringServes() {
    Path repoRoot = findRepoRoot();
    assertThat(repoRoot).as("racine du repo introuvable").isNotNull();
    PermissionService service = new PermissionService(null, null, new ObjectMapper());

    List<String> mismatches = new ArrayList<>();
    int checked = 0;
    for (Map.Entry<String, List<String>> entry : SERVICE_MANIFESTS.entrySet()) {
      List<String> routes =
          entry.getValue().stream()
              .flatMap(rel -> readManifest(repoRoot.resolve(rel)).stream())
              .distinct()
              .toList();
      for (String route : routes) {
        for (String sample : SAMPLE_VALUES) {
          String method = route.substring(0, route.indexOf(' '));
          String rawPath = route.substring(route.indexOf(' ') + 1).replaceAll("\\{[^}]+}", sample);
          String served = springChoice(routes, method, rawPath);
          String decided = service.matchingRuleSignature(method, rawPath);
          checked++;
          if (served == null
              || decided == null
              || !normalizeSignature(served).equals(normalizeSignature(decided))) {
            mismatches.add(
                entry.getKey()
                    + " : "
                    + method
                    + " "
                    + rawPath
                    + " → Spring sert "
                    + served
                    + ", la règle appliquée est "
                    + decided);
          }
        }
      }
    }

    assertThat(checked).as("aucun chemin vérifié — manifestes vides ?").isPositive();
    // Le gateway n'accepte que l'encodage de caractères NON ASCII : ils ne peuvent correspondre
    // qu'à une variable si chaque littéral de route est en ASCII. Une route au littéral accentué
    // romprait cette hypothèse.
    assertThat(
            SERVICE_MANIFESTS.values().stream()
                .flatMap(List::stream)
                .flatMap(rel -> readManifest(repoRoot.resolve(rel)).stream())
                .filter(r -> !r.replaceAll("\\{[^}]+}", "").chars().allMatch(c -> c < 0x80)))
        .as("routes dont un littéral n'est pas en ASCII")
        .isEmpty();
    assertThat(mismatches)
        .as(
            "La règle de permission appliquée n'est pas celle de la route servie par Spring. "
                + "Placer la règle la plus précise AVANT la règle générique dans buildRules().")
        .isEmpty();
  }

  /**
   * Route que Spring MVC sert pour ce chemin brut : parmi les routes du service de même verbe,
   * celles dont le motif correspond (segments décodés par {@link PathContainer}), la plus
   * spécifique selon {@link PathPattern#SPECIFICITY_COMPARATOR}. Null si aucune.
   */
  private static String springChoice(List<String> routes, String method, String rawPath) {
    PathContainer path = PathContainer.parsePath(rawPath);
    return routes.stream()
        .filter(r -> r.startsWith(method + " "))
        .map(r -> Map.entry(r, PathPatternParser.defaultInstance.parse(r.substring(r.indexOf(' ') + 1))))
        .filter(e -> e.getValue().matches(path))
        .sorted(Comparator.comparing(Map.Entry::getValue, PathPattern.SPECIFICITY_COMPARATOR))
        .map(Map.Entry::getKey)
        .findFirst()
        .orElse(null);
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
