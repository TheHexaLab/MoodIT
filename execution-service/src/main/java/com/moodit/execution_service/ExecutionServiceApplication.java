package com.moodit.execution_service;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Microservice d'EXÉCUTION du code étudiant (questions Code). Exécute chaque harnais contre
 * une soumission dans un sandbox Piston (isolation, pas de réseau, limites CPU/mémoire/temps)
 * et renvoie le verdict par test. Servi sous /exec (le gateway route /exec/** ici, port 8084).
 * N'exécute JAMAIS le code dans son propre process : tout passe par Piston.
 */
@SpringBootApplication
public class ExecutionServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ExecutionServiceApplication.class, args);
    }
}
