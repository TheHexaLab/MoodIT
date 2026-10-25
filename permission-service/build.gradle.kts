plugins {
    java
    jacoco
    id("info.solidsoft.pitest") version "1.19.0"
    id("org.springframework.boot") version "4.0.9"
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

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    // Jackson : parsing du body JSON transmis par le gateway (PermissionService).
    implementation("org.springframework.boot:spring-boot-starter-json")
    compileOnly("org.projectlombok:lombok")
    runtimeOnly("org.postgresql:postgresql")
    annotationProcessor("org.projectlombok:lombok")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    // Slice @DataJpaTest + TestEntityManager (module dédié en Spring Boot 4).
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test")
    // Base en mémoire (mode PostgreSQL) pour tester les requêtes SQL natives du
    // MembershipRepository sans Docker/Postgres (MembershipRepositoryTest).
    testRuntimeOnly("com.h2database:h2")
    testCompileOnly("org.projectlombok:lombok")
    testAnnotationProcessor("org.projectlombok:lombok")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
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
// sur main, pas sur chaque PR (plusieurs minutes). Le test de contexte, qui exige Postgres, est exclu.
pitest {
    pitestVersion = "1.30.1"
    junit5PluginVersion = "1.2.3"
    targetClasses = setOf("com.moodit.permission_service.service.*")
    excludedTestClasses = setOf("*ApplicationTests")
    threads = 4
    outputFormats = setOf("XML", "HTML")
    timestampedReports = false
    mutationThreshold = 90 // seuil commun aux six services ; score mesuré le 2026-10-25 : 98 % (code mort retiré, #117)
}
