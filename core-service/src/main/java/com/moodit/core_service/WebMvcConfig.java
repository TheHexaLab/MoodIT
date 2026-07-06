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
    // Le préfixe /api ne s'applique QU'À NOS contrôleurs (package com.moodit.core_service),
    // SAUF les outils realtime/dev et les endpoints INTERNES (service à service : /internal/**).
    //
    // ⚠ On EXCLUT explicitement les contrôleurs de Spring (ex. BasicErrorController) : sinon
    // /error devient /api/error, et le forward interne vers /error (déclenché par toute
    // exception non gérée) ne mappe plus rien → 404 trompeur au lieu du vrai code (500…).
    configurer.addPathPrefix(
        "/api",
        type -> {
          String pkg = type.getPackageName();
          return pkg.startsWith("com.moodit.core_service")
              && !pkg.startsWith("com.moodit.core_service.realtime")
              && !pkg.startsWith("com.moodit.core_service.internal");
        });
  }
}
