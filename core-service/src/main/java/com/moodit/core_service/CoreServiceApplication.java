package com.moodit.core_service;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import lombok.RequiredArgsConstructor;

@SpringBootApplication
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class CoreServiceApplication {

  private final JdbcTemplate jdbcTemplate;

  public static void main(String[] args) {
    SpringApplication.run(CoreServiceApplication.class, args);
  }

  @GetMapping(value = "/test", produces = "text/plain")
  public String test() {
    try {
      jdbcTemplate.queryForObject("SELECT 1", Integer.class);
      return "Core + BD fonctionnels!";
    } catch (Exception e) {
      return "Core fonctionnel, BD down.";
    }
  }
}
