// Préfixe /api appliqué à TOUS les contrôleurs REST sauf les outils realtime/dev.
//
// On n'utilise PAS spring.mvc.servlet.path=/api : ce réglage déplacerait aussi
// l'endpoint WebSocket (/ws) et le DevWsController (/dev/ws) sous /api. Ici le
// DispatcherServlet reste à la racine, donc /ws et /dev/ws gardent leurs chemins ;
// seuls les @RestController hors du package `realtime` reçoivent /api
// (ex. /programs → /api/programs, /me → /api/me, /test → /api/test).
//
// Les contrôleurs restent donc « propres » (mappés sur /programs, /me, …) : ne PAS
// ré-ajouter /api dans leurs @RequestMapping, sinon on obtient /api/api/...

package com.moodit.core_service;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

  @Override
  public void configurePathMatch(PathMatchConfigurer configurer) {
    configurer.addPathPrefix(
        "/api", type -> !type.getPackageName().startsWith("com.moodit.core_service.realtime"));
  }
}
