package com.moodit.mcp_service;

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
 * Génère/valide le MANIFESTE des routes MUTANTES du mcp-service par INTROSPECTION SPRING. Voir
 * la version core-service pour les détails du mécanisme. Ici le préfixe externe est vide : les
 * contrôleurs mcp portent déjà {@code @RequestMapping("/mcp")} et le gateway ne strippe pas.
 */
class MutatingRouteManifestTest {

  private static final String BASE_PACKAGE = "com.moodit.mcp_service";
  private static final String EXTERNAL_PREFIX = ""; // @RequestMapping("/mcp") déjà dans le contrôleur

  private static final Path MANIFEST = Paths.get("src", "test", "resources", "mutating-routes.txt");
  private static final String HEADER =
      "# Routes mutantes (POST/PUT/PATCH/DELETE) exposées via le gateway. GÉNÉRÉ par\n"
          + "# MutatingRouteManifestTest (introspection Spring) — NE PAS éditer à la main.\n"
          + "# Lu par le RouteCoverageTest du permission-service (couverture des règles).\n";

  private static final Set<RequestMethod> MUTATING =
      EnumSet.of(RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE);

  @Test
  void manifestMatchesActualMutatingRoutes() throws IOException {
    List<String> actual = scanMutatingRoutes(BASE_PACKAGE, EXTERNAL_PREFIX);

    List<String> committed =
        Files.exists(MANIFEST)
            ? Files.readAllLines(MANIFEST).stream()
                .filter(l -> !l.isBlank() && !l.startsWith("#"))
                .sorted()
                .toList()
            : List.of();

    if (!committed.equals(actual)) {
      Files.createDirectories(MANIFEST.getParent());
      Files.writeString(MANIFEST, HEADER + String.join("\n", actual) + "\n");
      fail(
          "Manifeste des routes mutantes périmé — RÉGÉNÉRÉ ("
              + MANIFEST
              + ", "
              + actual.size()
              + " routes). Committe le fichier. Attendu:\n"
              + String.join("\n", actual));
    }
  }

  static List<String> scanMutatingRoutes(String basePackage, String prefix) {
    ClassPathScanningCandidateComponentProvider scanner =
        new ClassPathScanningCandidateComponentProvider(false);
    scanner.addIncludeFilter(new AnnotationTypeFilter(Controller.class));

    Set<String> routes = new TreeSet<>();
    for (BeanDefinition bd : scanner.findCandidateComponents(basePackage)) {
      Class<?> clazz;
      try {
        clazz = Class.forName(bd.getBeanClassName());
      } catch (ClassNotFoundException e) {
        throw new IllegalStateException(e);
      }
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
        verbs.retainAll(MUTATING);
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

  private static String[] paths(RequestMapping rm) {
    return rm.path().length == 0 ? new String[] {""} : rm.path();
  }

  private static String clean(String path) {
    String p = path.replaceAll("/{2,}", "/");
    return (p.length() > 1 && p.endsWith("/")) ? p.substring(0, p.length() - 1) : p;
  }
}
