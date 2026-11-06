-- #116 — Harnais des langages COMPILÉS = VRAIS tests du langage.
--
-- Les compilés ne sont plus notés via Piston mais dans un CONTENEUR RUNNER jetable
-- (execution-service, sandbox/DockerEvaluator + superviseur) : le harnais du prof est un vrai
-- test — classe JUnit 5 (Java), classe NUnit (C#), fichier _test.go (Go), module #[cfg(test)]
-- (Rust), MOODIT_TEST de moodit_check.h (C/C++). La POO est du simple code de test ; le code
-- étudiant est exécuté sous un UID dédié, harnais verrouillé, verdict fail-closed gardé par des
-- canaris. Cette migration remplace les gabarits `harness_template` des 6 compilés (semés en V2,
-- déjà fusionnée → UPDATE forward-only).
UPDATE Language SET harness_template = ht.tpl
FROM (VALUES
    ('Java', $hc$// HARNAIS (Java) — une VRAIE classe de test JUnit 5, compilée avec le code de l'étudiant.
// Chaque méthode @Test est un cas de vérification ; une assertion ratée ou une exception = échec.
// La POO est du code normal : assertEquals(12, new Rectangle(3, 4).aire()).
// Sandbox : JDK 25 + JUnit 5 (aucun réseau). Le code étudiant ne peut pas lire ce harnais.
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class Harnais {
    @Test
    void solutionAttendue() {
        assertEquals(ATTENDU, Solution.solution());
    }
}
$hc$),
    ('C#', $hc$// HARNAIS (C#) — une VRAIE classe de test NUnit, compilée avec le code de l'étudiant.
// Chaque méthode [Test] est un cas de vérification ; une assertion ratée ou une exception = échec.
// La POO est du code normal : Assert.That(new Rectangle(3, 4).Aire(), Is.EqualTo(12)).
// Sandbox : Mono + NUnit (aucun réseau). Le code étudiant ne peut pas lire ce harnais.
using NUnit.Framework;

public class Harnais
{
    [Test]
    public void SolutionAttendue()
    {
        Assert.That(Solution.solution(), Is.EqualTo(ATTENDU));
    }
}
$hc$),
    ('Go', $hc$// HARNAIS (Go) — un VRAI test go : fichier _test.go du MÊME package que le code de l'étudiant
// (ses identifiants non exportés sont accessibles). Chaque func TestXxx(t *testing.T) est un cas ;
// t.Fatalf / t.Errorf signale un échec.
// Sandbox : bibliothèque standard Go (aucun réseau). Le code étudiant ne peut pas lire ce harnais.
package main

import "testing"

func TestSolution(t *testing.T) {
	if solution() != ATTENDU {
		t.Fatalf("solution() = %v, attendu %v", solution(), ATTENDU)
	}
}
$hc$),
    ('Rust', $hc$// HARNAIS (Rust) — un VRAI module de tests cargo, ajouté au fichier de l'étudiant
// (use super::* donne accès à ses items, même privés). Chaque fn #[test] est un cas ;
// assert_eq! / assert! ; un panic vaut échec.
// Sandbox : bibliothèque standard Rust (aucun réseau, pas de crate externe).
#[cfg(test)]
mod harnais {
    use super::*;

    #[test]
    fn solution_attendue() {
        assert_eq!(solution(), ATTENDU);
    }
}
$hc$),
    ('C', $hc$// HARNAIS (C) — tests moodit_check. Le code de l'étudiant est inclus automatiquement
// (son main est neutralisé) : ses fonctions sont appelables directement.
// Chaque MOODIT_TEST(nom) est un cas ; MOODIT_CHECK(condition) ou MOODIT_CHECK_MSG(cond, "message").
// Sandbox : libc (aucun réseau). Le code étudiant ne peut pas lire ce harnais.
MOODIT_TEST(solution_attendue) {
    MOODIT_CHECK(solution() == ATTENDU);
}
$hc$),
    ('C++', $hc$// HARNAIS (C++) — tests moodit_check. Le code de l'étudiant est inclus automatiquement
// (son main est neutralisé) : classes et fonctions sont utilisables directement,
// ex. MOODIT_CHECK(Rectangle(3, 4).aire() == 12).
// Chaque MOODIT_TEST(nom) est un cas ; MOODIT_CHECK(condition) ou MOODIT_CHECK_MSG(cond, "message").
// Sandbox : STL (aucun réseau). Le code étudiant ne peut pas lire ce harnais.
MOODIT_TEST(solution_attendue) {
    MOODIT_CHECK(solution() == ATTENDU);
}
$hc$)
) AS ht(name, tpl)
WHERE Language.name = ht.name;
