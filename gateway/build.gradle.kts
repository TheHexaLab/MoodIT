plugins {
    java
    jacoco
    id("info.solidsoft.pitest") version "1.19.0"
    id("org.springframework.boot") version "4.0.6"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.moodit"
version = "0.0.1-SNAPSHOT"

java {

    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

extra["springCloudVersion"] = "2025.1.1"

dependencies {
    implementation("org.springframework.cloud:spring-cloud-starter-gateway-server-webmvc")
    // Proxy WebSocket : le gateway webmvc ne sait pas relayer le ws nativement
    // (spring-cloud/spring-cloud-gateway#3442), on le fait nous-mêmes avec spring-websocket.
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("io.jsonwebtoken:jjwt-api:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-impl:0.12.6")
    runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.12.6")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    implementation("org.springframework.boot:spring-boot-starter-security")
}

dependencyManagement {
    imports {
        mavenBom("org.springframework.cloud:spring-cloud-dependencies:${property("springCloudVersion")}")
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

// Couverture (#90) : rapport JaCoCo après `test` (build/reports/jacoco/test/html, XML pour la CI).
// 0.8.14 : première version qui instrumente les classes Java 25.
jacoco {
    toolVersion = "0.8.14"
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required = true
        html.required = true
    }
}

tasks.test {
    finalizedBy(tasks.jacocoTestReport)
}

// Tests de mutation (#90) : `./gradlew pitest` (rapport build/reports/pitest/). PIT modifie le code
// (conditions inversées, retours changés…) et vérifie que les tests le détectent. Lancé la nuit et
// sur main, pas sur chaque PR (plusieurs minutes). Tests exigeant Postgres, Docker ou un LLM exclus.
// Hors périmètre : configuration, DTO et entités (pas de logique à muter).
pitest {
    pitestVersion = "1.30.1"
    junit5PluginVersion = "1.2.3"
    targetClasses = setOf("com.moodit.gateway.*")
    excludedClasses = setOf("*Application", "*.config.*", "*.dto.*", "*.entity.*", "*.model.*")
    excludedTestClasses = setOf("*ApplicationTests", "*IT", "*IntegrationTest*")
    excludedGroups = setOf("integration")
    threads = 4
    outputFormats = setOf("XML", "HTML")
    timestampedReports = false
    timeoutConstInMillis = 8000
    mutationThreshold = 90 // seuil commun aux six services ; score mesuré le 2026-10-23 : 94 %
}
