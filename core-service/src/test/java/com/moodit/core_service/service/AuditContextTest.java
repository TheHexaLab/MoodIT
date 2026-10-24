package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Chaînes de contexte du journal d'audit : segments séparés par un retour de ligne (le frontend
 * les redécoupe), programmes nommés dans l'ordre, établissements dédupliqués, null sans contexte.
 */
class AuditContextTest {

    private static Establishment establishment(String name) {
        Establishment e = new Establishment();
        e.setName(name);
        return e;
    }

    private static Program program(String name, Establishment e) {
        return Program.builder().name(name).establishment(e).build();
    }

    @Test
    @DisplayName("ofPrograms : programmes puis établissements dédupliqués, séparés par SEP")
    void ofPrograms_programmesEtEtablissementsDedupliques() {
        Establishment udes = establishment("UdeS");
        Establishment ets = establishment("ÉTS");

        String details = AuditContext.ofPrograms(List.of(
                program("Informatique", udes), program("Génie", udes), program("Réseaux", ets)));

        assertThat(details).isEqualTo(
                "Programmes : Informatique, Génie, Réseaux" + AuditContext.SEP + "Établissements : UdeS, ÉTS");
    }

    @Test
    @DisplayName("ofPrograms : liste null ou vide → null")
    void ofPrograms_sansProgramme_null() {
        assertThat(AuditContext.ofPrograms(null)).isNull();
        assertThat(AuditContext.ofPrograms(List.of())).isNull();
    }

    @Test
    @DisplayName("ofPrograms : noms vides ignorés ; établissement absent ou sans nom → pas de segment")
    void ofPrograms_nomsVidesEtEtablissementsAbsents() {
        String details = AuditContext.ofPrograms(List.of(
                program("Informatique", null), program("  ", establishment(null)), program(null, null)));

        assertThat(details).isEqualTo("Programmes : Informatique");
    }

    @Test
    @DisplayName("ofPrograms : seulement des établissements (programmes sans nom) → segment établissements seul")
    void ofPrograms_seulementEtablissements() {
        assertThat(AuditContext.ofPrograms(List.of(program(null, establishment("UdeS")))))
                .isEqualTo("Établissements : UdeS");
    }

    @Test
    @DisplayName("ofCourse : contexte des programmes du cours ; cours null → null")
    void ofCourse() {
        Course course = Course.builder().title("Algo").code("IFT1")
                .programs(new ArrayList<>(List.of(program("Informatique", establishment("UdeS"))))).build();

        assertThat(AuditContext.ofCourse(course))
                .isEqualTo("Programmes : Informatique" + AuditContext.SEP + "Établissements : UdeS");
        assertThat(AuditContext.ofCourse(null)).isNull();
    }

    @Test
    @DisplayName("ofChildOfCourse : cours en tête, puis programmes et établissements")
    void ofChildOfCourse() {
        Course course = Course.builder().title("Algo").code("IFT1")
                .programs(new ArrayList<>(List.of(program("Informatique", establishment("UdeS"))))).build();

        assertThat(AuditContext.ofChildOfCourse(course)).isEqualTo("Cours : Algo (IFT1)" + AuditContext.SEP
                + "Programmes : Informatique" + AuditContext.SEP + "Établissements : UdeS");
        assertThat(AuditContext.ofChildOfCourse(null)).isNull();
    }
}
