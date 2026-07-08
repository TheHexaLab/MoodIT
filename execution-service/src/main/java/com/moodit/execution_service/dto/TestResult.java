package com.moodit.execution_service.dto;

/**
 * Verdict d'un harnais. {@code passed} = le programme assemblé s'est terminé en succès (exit 0).
 * {@code detail} porte un message utile en cas d'échec (erreur de compilation, stderr, timeout) —
 * précieux pour le prof qui met au point son harnais ; à ne PAS exposer à l'étudiant en passation.
 * Miroir du type front {@code CodingTestResult} (name/passed/weight), enrichi de {@code detail}.
 */
public record TestResult(String name, int weight, boolean passed, String detail) {}
