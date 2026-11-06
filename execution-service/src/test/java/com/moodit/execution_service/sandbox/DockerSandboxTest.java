package com.moodit.execution_service.sandbox;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Archive tar du job runner (#116) : chemins sous /box, fichiers 0600, sentinelle en dernier. */
class DockerSandboxTest {

    @Test
    void tar_place_les_fichiers_sous_box_en_0600_et_ready_en_dernier() throws IOException {
        Map<String, String> files = new LinkedHashMap<>();
        files.put("job.json", "{}");
        files.put("cases/0/src/main.go", "package main");

        List<TarArchiveEntry> entries = new ArrayList<>();
        List<String> contents = new ArrayList<>();
        try (TarArchiveInputStream tar =
                new TarArchiveInputStream(new ByteArrayInputStream(DockerSandbox.tarOf(files)))) {
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                entries.add(entry);
                contents.add(new String(tar.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
        assertThat(entries).extracting(TarArchiveEntry::getName)
                .containsExactly("box/job.json", "box/cases/0/src/main.go", "box/.ready");
        // 0600 : illisible par l'UID étudiant dès l'extraction (le superviseur relâche les artefacts).
        assertThat(entries).allSatisfy(e -> assertThat(e.getMode() & 0777).isEqualTo(0600));
        assertThat(contents.get(1)).isEqualTo("package main");
    }

    @Test
    void hote_docker_par_defaut_selon_l_os() {
        String host = DockerSandbox.defaultDockerHost();
        if (System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")) {
            assertThat(host).startsWith("npipe://");
        } else {
            assertThat(host).startsWith("unix://");
        }
    }

    // ── Démon injoignable : échec PROPRE (SandboxException / false), jamais un faux verdict ──
    // tcp vers un port fermé de localhost : refus immédiat, aucun démon requis par ces tests.

    private final DockerSandbox unreachable = new DockerSandbox("tcp://127.0.0.1:1", 512, 64, 1.0);

    @Test
    void demon_injoignable_available_et_image_present_repondent_false() {
        assertThat(unreachable.available()).isFalse();
        assertThat(unreachable.imagePresent("moodit-runner-go:latest")).isFalse();
    }

    @Test
    void demon_injoignable_run_leve_sandbox_exception() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> unreachable.run("moodit-runner-go:latest", Map.of("job.json", "{}"), 1000))
                .isInstanceOf(SandboxException.class);
    }
}
