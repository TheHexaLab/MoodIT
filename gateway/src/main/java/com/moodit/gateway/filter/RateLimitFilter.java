package com.moodit.gateway.filter;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;

// verrou de connexion PAR COMPTE dans auth-service (AuthService.login).

public class RateLimitFilter extends OncePerRequestFilter {

  // Routes qui déclenchent l'envoi de courriels : quota strict.
  private static final int EMAIL_ROUTE_CAPACITY = 5;
  // Login : quota un peu plus large
  private static final int LOGIN_CAPACITY = 10;

  // Un seau par (groupe de routes), avec éviction automatique des IP inactives.
  private final Cache<String, Bucket> buckets =
      Caffeine.newBuilder().expireAfterAccess(Duration.ofMinutes(10)).maximumSize(100_000).build();

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {

    String group = resolveGroup(request.getRequestURI());

    // Route non concernée par le rate limiting : on laisse passer.
    if (group == null) {
      filterChain.doFilter(request, response);
      return;
    }

    String key = group + "|" + request.getRemoteAddr();
    Bucket bucket = buckets.get(key, k -> newBucket(capacityFor(group)));

    if (bucket.tryConsume(1)) {
      filterChain.doFilter(request, response);
    } else {
      response.setStatus(429); // 429 Too Many Requests
      response.setHeader("Retry-After", "60");
      response.getWriter().write("Trop de requêtes. Réessayez dans une minute.");
    }
  }

  private String resolveGroup(String path) {
    if (path.equals("/auth/register")
        || path.startsWith("/auth/verify")
        || path.equals("/auth/resend-code")) {
      return "email";
    }
    if (path.equals("/auth/login")) {
      return "login";
    }
    return null;
  }

  private int capacityFor(String group) {
    return "email".equals(group) ? EMAIL_ROUTE_CAPACITY : LOGIN_CAPACITY;
  }

  private Bucket newBucket(int capacity) {
    Bandwidth limit =
        Bandwidth.builder()
            .capacity(capacity)
            .refillGreedy(capacity, Duration.ofMinutes(1))
            .build();
    return Bucket.builder().addLimit(limit).build();
  }
}
