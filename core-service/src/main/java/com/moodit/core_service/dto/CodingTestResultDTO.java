package com.moodit.core_service.dto;

/**
 * Verdict d'un harnais renvoyé au front pour une question Code (miroir du type front
 * {@code CodingTestResult}). {@code name} et {@code weight} viennent du Test_Case ; {@code passed}
 * du job d'exécution. Le code du harnais n'est JAMAIS exposé ici.
 */
public record CodingTestResultDTO(String name, boolean passed, int weight) {}
