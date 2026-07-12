package com.moodit.core_service.service;

import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Program;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Construit les chaînes de contexte PARENT (établissement → programme → cours) pour le journal
 * d'audit ({@code details}). Un cours pouvant appartenir à plusieurs programmes — potentiellement
 * dans plusieurs établissements — les listes sont dédupliquées. Chaque « segment » est séparé par
 * « · » (le frontend le redécoupe en puces). Renvoie null si aucun contexte n'est disponible.
 *
 * <p>Les collections {@code course.getPrograms()} sont LAZY : appeler ces méthodes dans une session
 * ouverte (méthode @Transactional ou open-in-view actif pendant la requête).
 */
public final class AuditContext {

    private AuditContext() {}

    /** Contexte d'un COURS : « Programmes : … · Établissements : … ». */
    public static String ofCourse(Course course) {
        if (course == null) {
            return null;
        }
        return ofPrograms(course.getPrograms());
    }

    /** Contexte d'un ENFANT de cours (FORUM/QUIZ/INSCRIPTION) : « Cours : … · Programmes : … · Établissements : … ». */
    public static String ofChildOfCourse(Course course) {
        if (course == null) {
            return null;
        }
        return join(coursePart(course), programsPart(course.getPrograms()), establishmentsPart(course.getPrograms()));
    }

    /** Contexte à partir d'une liste de programmes (ex. cours en cours de création) : « Programmes : … · Établissements : … ». */
    public static String ofPrograms(List<Program> programs) {
        return join(programsPart(programs), establishmentsPart(programs));
    }

    // ── Segments ────────────────────────────────────────────────────────────

    private static String coursePart(Course c) {
        return "Cours : " + c.getTitle() + " (" + c.getCode() + ")";
    }

    private static String programsPart(List<Program> programs) {
        if (programs == null || programs.isEmpty()) {
            return null;
        }
        String names =
                programs.stream()
                        .map(Program::getName)
                        .filter(n -> n != null && !n.isBlank())
                        .collect(Collectors.joining(", "));
        return names.isEmpty() ? null : "Programmes : " + names;
    }

    private static String establishmentsPart(List<Program> programs) {
        if (programs == null || programs.isEmpty()) {
            return null;
        }
        Set<String> establishments = new LinkedHashSet<>(); // dédup en gardant l'ordre
        for (Program p : programs) {
            if (p.getEstablishment() != null && p.getEstablishment().getName() != null) {
                establishments.add(p.getEstablishment().getName());
            }
        }
        return establishments.isEmpty() ? null : "Établissements : " + String.join(", ", establishments);
    }

    /** Assemble les segments non vides avec « · » ; null si tout est vide. */
    private static String join(String... parts) {
        String joined =
                Arrays.stream(parts)
                        .filter(p -> p != null && !p.isBlank())
                        .collect(Collectors.joining(" · "));
        return joined.isEmpty() ? null : joined;
    }
}
