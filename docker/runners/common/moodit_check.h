/* moodit_check.h — mini-framework de test C/C++ des harnais MoodIT (#116).
 *
 * Usage dans un harnais :
 *     MOODIT_TEST(aire_rectangle) {
 *         Rectangle r = {3, 4};
 *         MOODIT_CHECK(aire(&r) == 12);
 *         MOODIT_CHECK_MSG(perimetre(&r) == 14, "perimetre(3x4) devrait valoir 14");
 *     }
 *
 * Chaque MOODIT_TEST est enregistré automatiquement ; le main fourni ici les exécute tous et
 * imprime une ligne par test puis un sommaire machine-lisible, lu par le superviseur :
 *     [MOODIT] ok <nom>            [MOODIT] fail <nom> (fichier:ligne) message
 *     [MOODIT] summary jeton=<jeton> total=N failed=M   (jeton=… seulement si MOODIT_JETON)
 * Un MOODIT_CHECK qui échoue interrompt le test courant (longjmp) et le marque échoué.
 * Code de sortie : 0 si tout passe, 1 sinon. Compatible C (gcc) et C++ (g++).
 */
#ifndef MOODIT_CHECK_H
#define MOODIT_CHECK_H

#include <setjmp.h>
#include <stdio.h>

#define MOODIT_MAX_TESTS 256

typedef void (*moodit_test_fn)(void);

struct moodit_test {
    const char *name;
    moodit_test_fn fn;
};

static struct moodit_test moodit_tests[MOODIT_MAX_TESTS];
static int moodit_test_count = 0;
static jmp_buf moodit_jump;
static int moodit_current_failed = 0;

static void moodit_register(const char *name, moodit_test_fn fn) {
    if (moodit_test_count < MOODIT_MAX_TESTS) {
        moodit_tests[moodit_test_count].name = name;
        moodit_tests[moodit_test_count].fn = fn;
        moodit_test_count++;
    }
}

#define MOODIT_TEST(name)                                                    \
    static void moodit_test_##name(void);                                    \
    __attribute__((constructor)) static void moodit_reg_##name(void) {       \
        moodit_register(#name, moodit_test_##name);                          \
    }                                                                        \
    static void moodit_test_##name(void)

static void moodit_fail(const char *name, const char *file, int line, const char *msg) {
    printf("[MOODIT] fail %s (%s:%d)%s%s\n", name, file, line, msg[0] ? " " : "", msg);
    moodit_current_failed = 1;
    longjmp(moodit_jump, 1);
}

static const char *moodit_current_name = "";

#define MOODIT_CHECK(cond)                                                   \
    do {                                                                     \
        if (!(cond)) moodit_fail(moodit_current_name, __FILE__, __LINE__, #cond); \
    } while (0)

#define MOODIT_CHECK_MSG(cond, msg)                                          \
    do {                                                                     \
        if (!(cond)) moodit_fail(moodit_current_name, __FILE__, __LINE__, msg); \
    } while (0)

int main(void) {
    int failed = 0;
    int i;
    for (i = 0; i < moodit_test_count; i++) {
        moodit_current_name = moodit_tests[i].name;
        moodit_current_failed = 0;
        if (setjmp(moodit_jump) == 0) {
            moodit_tests[i].fn();
        }
        if (moodit_current_failed) {
            failed++;
        } else {
            printf("[MOODIT] ok %s\n", moodit_tests[i].name);
        }
    }
#ifdef MOODIT_JETON
    /* Sommaire PORTEUR DU JETON : le superviseur ne compte que celui-ci. Sans le jeton, le
     * code noté n'avait qu'à imprimer « [MOODIT] summary total=1 failed=0 » AVANT la fin (le
     * superviseur retenait le PREMIER sommaire trouvé), puis à poser un atexit() qui sort en 0 :
     * le vrai sommaire et le vrai jeton étaient bien imprimés ensuite, et le cas passait au vert.
     * Le jeton vit dans le harnais (illisible, 700 root) et dans ce binaire (dont la lecture est
     * tracée, lecture_binaire_tentee) — le forger redevient donc bruyant ou impossible. */
    printf("[MOODIT] summary jeton=%s total=%d failed=%d\n",
           MOODIT_JETON, moodit_test_count, failed);
    /* Jeton de fin d'exécution : n'est imprimé qu'ici, après tous les tests — un exit(0) forgé
     * depuis le code étudiant le saute. */
    printf("[MOODIT] jeton=%s\n", MOODIT_JETON);
#else
    printf("[MOODIT] summary total=%d failed=%d\n", moodit_test_count, failed);
#endif
    fflush(stdout);
    return failed > 0 ? 1 : 0;
}

#endif /* MOODIT_CHECK_H */
