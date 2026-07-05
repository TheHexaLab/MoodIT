package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Assemble {@code code étudiant + harnais} en un programme exécutable dont l'EXIT CODE traduit le
 * verdict (0 = réussi, non-zéro = échec) — Piston ne renvoie que stdout/stderr/exit, pas de valeur
 * de retour. Le contrat du harnais (renvoie un booléen ; une exception vaut échec) est enveloppé
 * ici, PAR LANGAGE. Slice actuel : Python. Les autres langages viendront un à un.
 */
@Component
public class CodeAssembler {

    /** Programme prêt pour Piston : langage Piston + fichiers. */
    public record Assembled(String pistonLanguage, List<PistonClient.File> files) {}

    public Assembled assemble(String language, String studentCode, String harnessCode) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return switch (lang) {
            case "python" -> assemblePython(studentCode, harnessCode);
            default -> throw new UnsupportedLanguageException(language);
        };
    }

    /**
     * Assemble le code pour une EXÉCUTION SIMPLE (sans harnais) : on lance le programme tel quel et
     * on renvoie sa sortie. Même périmètre de langages que {@link #assemble} (Python pour l'instant).
     */
    public Assembled assembleRun(String language, String studentCode) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        String code = studentCode == null ? "" : studentCode;
        return switch (lang) {
            case "python" -> new Assembled("python", List.of(new PistonClient.File("main.py", code)));
            default -> throw new UnsupportedLanguageException(language);
        };
    }

    /**
     * Python : code étudiant, puis harnais enveloppé dans une fonction appelée ; son booléen de
     * retour → exit 0/1, toute exception → exit 1. Le harnais est un CORPS de fonction (cf.
     * harness_template), donc indenté d'un niveau.
     */
    private Assembled assemblePython(String studentCode, String harnessCode) {
        String program = studentCode
                + "\n\n\ndef __moodit_harness():\n"
                + indent(harnessCode, "    ")
                + "\n\nimport sys as __moodit_sys\n"
                + "try:\n"
                + "    __moodit_result = __moodit_harness()\n"
                + "    __moodit_sys.exit(0 if __moodit_result else 1)\n"
                + "except SystemExit:\n"
                + "    raise\n"
                + "except BaseException:\n"
                + "    __moodit_sys.exit(1)\n";
        return new Assembled("python", List.of(new PistonClient.File("main.py", program)));
    }

    /** Indente chaque ligne non vide par {@code prefix} (préserve l'indentation relative). */
    private static String indent(String code, String prefix) {
        return code.lines()
                .map(line -> line.isBlank() ? "" : prefix + line)
                .collect(Collectors.joining("\n"));
    }
}
