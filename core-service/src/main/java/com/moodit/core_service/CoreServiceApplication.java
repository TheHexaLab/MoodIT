package com.moodit.core_service;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import lombok.RequiredArgsConstructor;

// Pas de @RequestMapping("/api") ici : le préfixe /api est ajouté globalement par
// WebMvcConfig (addPathPrefix). /test est donc servi à /api/test.
@SpringBootApplication
@RestController
@RequiredArgsConstructor
public class CoreServiceApplication {

  public static void main(String[] args) {
    SpringApplication.run(CoreServiceApplication.class, args);
  }

}
