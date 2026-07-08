package com.moodit.execution_service.assembly;

/** Langage pas encore pris en charge par l'assemblage/exécution (→ 422 côté contrôleur). */
public class UnsupportedLanguageException extends RuntimeException {
    public UnsupportedLanguageException(String language) {
        super("Langage non encore supporté par l'exécution : " + language);
    }
}
