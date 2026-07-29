package com.moodit.core_service;

import static org.junit.jupiter.api.Assertions.fail;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

/**
 * Génère/valide les MANIFESTES de routes de ce service par INTROSPECTION SPRING (modèle
 * d'annotations {@code MergedAnnotations}, pas de regex, pas de contexte ni de BD). Deux manifestes,
 * tous deux lus par le RouteCoverageTest du permission-service (builds Gradle indépendants → on
 * passe par des fichiers versionnés) :
 *
 * <ul>
 *   <li>{@code mutating-routes.txt} : POST/PUT/PATCH/DELETE. Moteur en default-DENY → chaque
 *       mutation DOIT avoir une règle (sinon 403 silencieux = fonction cassée).
 *   <li>{@code readable-routes.txt} : GET. Moteur en default-ALLOW sur les lectures → chaque GET
 *       doit être GATÉ (règle) OU déclaré PUBLIC (allowlist du RouteCoverageTest), pour qu'un GET
 *       SENSIBLE oublié ne soit pas servi silencieusement à tout authentifié.
 * </ul>
 *
 * <p>Chaque test ÉCHOUE si le manifeste committé est périmé : il le régénère → il suffit de
 * committer le fichier. Les manifestes ne peuvent donc pas dériver des vraies routes.
 */
class MutatingRouteManifestTest {

  /** Package de base scanné. */
  private static final String BASE_PACKAGE = "com.moodit.core_service";

  /** Préfixe externe ajouté à TOUTES les routes du core par WebMvcConfig.addPathPrefix. */
  private static final String EXTERNAL_PREFIX = "/api";

  private static final Set<RequestMethod> MUTATING =
      EnumSet.of(RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE);
  private static final Set<RequestMethod> READABLE = EnumSet.of(RequestMethod.GET);

  private static final Path MUTATING_MANIFEST =
      Paths.get("src", "test", "resources", "mutating-routes.txt");
  private static final Path READABLE_MANIFEST =
      Paths.get("src", "test", "resources", "readable-routes.txt");

  private static final String MUTATING_HEADER =
      "# Routes mutantes (POST/PUT/PATCH/DELETE) exposées via le gateway. GÉNÉRÉ par\n"
          + "# MutatingRouteManifestTest (introspection Spring) — NE PAS éditer à la main.\n"
          + "# Lu par le RouteCoverageTest du permission-service (couverture des règles).\n";
  private static final String READABLE_HEADER =
      "# Routes de LECTURE (GET) exposées via le gateway. GÉNÉRÉ par\n"
          + "# MutatingRouteManifestTest (introspection Spring) — NE PAS éditer à la main.\n"
          + "# Lu par le RouteCoverageTest : chaque GET doit être GATÉ (règle) ou PUBLIC.\n";

  @Test
  void manifestMatchesActualMutatingRoutes() throws IOException {
    writeIfStale(
        MUTATING_MANIFEST, MUTATING_HEADER, scanRoutes(BASE_PACKAGE, EXTERNAL_PREFIX, MUTATING));
  }

  @Test
  void readableManifestMatchesActualGetRoutes() throws IOException {
    writeIfStale(
        READABLE_MANIFEST, READABLE_HEADER, scanRoutes(BASE_PACKAGE, EXTERNAL_PREFIX, READABLE));
  }

  /** Compare le manifeste committé aux routes réelles ; le régénère + échoue s'il a dérivé. */
  private static void writeIfStale(Path manifest, String header, List<String> actual)
      throws IOException {
    List<String> committed =
        Files.exists(manifest)
            ? Files.readAllLines(manifest).stream()
                .filter(l -> !l.isBlank() && !l.startsWith("#"))
                .sorted()
                .toList()
            : List.of();

    if (!committed.equals(actual)) {
      Files.createDirectories(manifest.getParent());
      Files.writeString(manifest, header + String.join("\n", actual) + "\n");
      fail(
          "Manifeste périmé — RÉGÉNÉRÉ ("
              + manifest
              + ", "
              + actual.size()
              + " routes). Committe le fichier. Attendu:\n"
              + String.join("\n", actual));
    }
  }

  /**
   * Introspection : routes (méthode + chemin préfixé) des @RestController du package, pour les
   * verbes demandés.
   */
  static List<String> scanRoutes(String basePackage, String prefix, Set<RequestMethod> wanted) {
    ClassPathScanningCandidateComponentProvider scanner =
        new ClassPathScanningCandidateComponentProvider(false);
    scanner.addIncludeFilter(new AnnotationTypeFilter(Controller.class)); // @RestController inclus (méta)

    Set<String> routes = new TreeSet<>();
    for (BeanDefinition bd : scanner.findCandidateComponents(basePackage)) {
      Class<?> clazz;
      try {
        clazz = Class.forName(bd.getBeanClassName());
      } catch (ClassNotFoundException e) {
        throw new IllegalStateException(e);
      }
      // Contrôleurs internes (X-Internal-Token, hors gateway) : non soumis au moteur.
      if (clazz.getName().contains(".internal.")) {
        continue;
      }
      RequestMapping classRm = AnnotatedElementUtils.findMergedAnnotation(clazz, RequestMapping.class);
      String[] basePaths = classRm == null ? new String[] {""} : paths(classRm);
      if (Arrays.stream(basePaths).anyMatch(b -> b.startsWith("/internal"))) {
        continue;
      }
      for (Method m : clazz.getDeclaredMethods()) {
        RequestMapping rm = AnnotatedElementUtils.findMergedAnnotation(m, RequestMapping.class);
        if (rm == null) {
          continue;
        }
        Set<RequestMethod> verbs = EnumSet.noneOf(RequestMethod.class);
        Collections.addAll(verbs, rm.method());
        verbs.retainAll(wanted);
        if (verbs.isEmpty()) {
          continue;
        }
        for (String base : basePaths) {
          for (String mp : paths(rm)) {
            for (RequestMethod verb : verbs) {
              routes.add(verb.name() + " " + clean(prefix + base + mp));
            }
          }
        }
      }
    }
    return new ArrayList<>(routes);
  }

  /** Chemins d'un @RequestMapping (value/path fusionnés) ; {""} si aucun. */
  private static String[] paths(RequestMapping rm) {
    return rm.path().length == 0 ? new String[] {""} : rm.path();
  }

  /** Effondre les // et retire un / final (hors racine). */
  private static String clean(String path) {
    String p = path.replaceAll("/{2,}", "/");
    return (p.length() > 1 && p.endsWith("/")) ? p.substring(0, p.length() - 1) : p;
  }
}
