-- #116 — DÉMO : conversion des harnais COMPILÉS vers les vrais frameworks de test.
--
-- Les questions compilées du quiz « Démo — Questions de code (multi-langages) » (GIF201, cf. V2_3)
-- gardaient des harnais « corps qui renvoie un booléen » (ancien assemblage Piston). Le runner
-- Docker (V7) attend de VRAIS tests : JUnit (Java), NUnit (C#), _test.go (Go), #[cfg(test)]
-- (Rust), MOODIT_TEST (C/C++). Les interprétés (Python, JS, TS, PHP, Bash) ne changent pas.
-- Idempotent sur une base sans la démo (JOIN vide).
UPDATE Test_Case SET harness_code = v.hc
FROM (VALUES
   -- ── doubler(n) ──
   (5, 'double de 5', $h$package main

import "testing"

func TestDoubleDeCinq(t *testing.T) {
	if doubler(5) != 10 {
		t.Fatalf("doubler(5) = %d, attendu 10", doubler(5))
	}
}
$h$),
   (5, 'négatif', $h$package main

import "testing"

func TestNegatif(t *testing.T) {
	if doubler(-3) != -6 {
		t.Fatalf("doubler(-3) = %d, attendu -6", doubler(-3))
	}
}
$h$),
   (6, 'double de 5', $h$#[cfg(test)]
mod harnais {
    use super::*;

    #[test]
    fn double_de_cinq() {
        assert_eq!(doubler(5), 10);
    }
}
$h$),
   (6, 'négatif', $h$#[cfg(test)]
mod harnais {
    use super::*;

    #[test]
    fn negatif() {
        assert_eq!(doubler(-3), -6);
    }
}
$h$),
   (7, 'double de 5', $h$MOODIT_TEST(double_de_cinq) {
    MOODIT_CHECK(doubler(5) == 10);
}
$h$),
   (7, 'négatif', $h$MOODIT_TEST(negatif) {
    MOODIT_CHECK(doubler(-3) == -6);
}
$h$),
   (8, 'double de 5', $h$MOODIT_TEST(double_de_cinq) {
    MOODIT_CHECK(doubler(5) == 10);
}
$h$),
   (8, 'négatif', $h$MOODIT_TEST(negatif) {
    MOODIT_CHECK(doubler(-3) == -6);
}
$h$),
   (9, 'double de 5', $h$using NUnit.Framework;

public class HarnaisDoubler
{
    [Test]
    public void DoubleDeCinq()
    {
        Assert.That(Solution.doubler(5), Is.EqualTo(10));
    }
}
$h$),
   (9, 'négatif', $h$using NUnit.Framework;

public class HarnaisDoubler
{
    [Test]
    public void Negatif()
    {
        Assert.That(Solution.doubler(-3), Is.EqualTo(-6));
    }
}
$h$),
   (10, 'double de 5', $h$import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HarnaisDoubler {
    @Test
    void doubleDeCinq() {
        assertEquals(10, Solution.doubler(5));
    }
}
$h$),
   (10, 'négatif', $h$import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HarnaisDoubler {
    @Test
    void negatif() {
        assertEquals(-6, Solution.doubler(-3));
    }
}
$h$),
   -- ── POO : Rectangle(largeur, hauteur).aire() ──
   (15, 'aire 3x4', $h$package main

import "testing"

func TestAire(t *testing.T) {
	r := Rectangle{largeur: 3, hauteur: 4}
	if r.aire() != 12 {
		t.Fatalf("aire(3x4) = %d, attendu 12", r.aire())
	}
}
$h$),
   (15, 'carré 5x5', $h$package main

import "testing"

func TestCarre(t *testing.T) {
	r := Rectangle{largeur: 5, hauteur: 5}
	if r.aire() != 25 {
		t.Fatalf("aire(5x5) = %d, attendu 25", r.aire())
	}
}
$h$),
   (16, 'aire 3x4', $h$#[cfg(test)]
mod harnais {
    use super::*;

    #[test]
    fn aire_3x4() {
        let r = Rectangle { largeur: 3, hauteur: 4 };
        assert_eq!(r.aire(), 12);
    }
}
$h$),
   (16, 'carré 5x5', $h$#[cfg(test)]
mod harnais {
    use super::*;

    #[test]
    fn carre_5x5() {
        let r = Rectangle { largeur: 5, hauteur: 5 };
        assert_eq!(r.aire(), 25);
    }
}
$h$),
   (17, 'aire 3x4', $h$MOODIT_TEST(aire_3x4) {
    MOODIT_CHECK(Rectangle(3, 4).aire() == 12);
}
$h$),
   (17, 'carré 5x5', $h$MOODIT_TEST(carre_5x5) {
    MOODIT_CHECK(Rectangle(5, 5).aire() == 25);
}
$h$),
   (18, 'aire 3x4', $h$using NUnit.Framework;

public class HarnaisRectangle
{
    [Test]
    public void Aire3x4()
    {
        Assert.That(new Rectangle(3, 4).aire(), Is.EqualTo(12));
    }
}
$h$),
   (18, 'carré 5x5', $h$using NUnit.Framework;

public class HarnaisRectangle
{
    [Test]
    public void Carre5x5()
    {
        Assert.That(new Rectangle(5, 5).aire(), Is.EqualTo(25));
    }
}
$h$),
   (19, 'aire 3x4', $h$import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HarnaisRectangle {
    @Test
    void aire3x4() {
        assertEquals(12, new Rectangle(3, 4).aire());
    }
}
$h$),
   (19, 'carré 5x5', $h$import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class HarnaisRectangle {
    @Test
    void carre5x5() {
        assertEquals(25, new Rectangle(5, 5).aire());
    }
}
$h$)
) AS v(oidx, name, hc)
WHERE Test_Case.name = v.name
  AND Test_Case.question_id = (
      SELECT qn.id FROM Question qn
      WHERE qn.order_index = v.oidx
        AND qn.quiz_id = (SELECT id FROM Quiz
                          WHERE title = 'Démo — Questions de code (multi-langages)'
                            AND course_id = (SELECT id FROM Course WHERE code = 'GIF201')));
