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
	// Web & WebSocket
	implementation("org.springframework.boot:spring-boot-starter-webmvc")
	implementation("org.springframework.boot:spring-boot-starter-websocket")

	// Données
	implementation("org.springframework.boot:spring-boot-starter-data-jpa")
	runtimeOnly("org.postgresql:postgresql")

	// Sécurité & JWT
	implementation("org.springframework.boot:spring-boot-starter-security")
	implementation("io.jsonwebtoken:jjwt-api:0.13.0")
	runtimeOnly("io.jsonwebtoken:jjwt-impl:0.13.0")
	runtimeOnly("io.jsonwebtoken:jjwt-jackson:0.13.0")

	// Validation
	implementation("org.springframework.boot:spring-boot-starter-validation")

	// Documentation API
	implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:3.1.1")

	// Lombok
	compileOnly("org.projectlombok:lombok")
	annotationProcessor("org.projectlombok:lombok")

	// MapStruct
	implementation("org.mapstruct:mapstruct:1.6.3")
	annotationProcessor("org.mapstruct:mapstruct-processor:1.6.3")
	annotationProcessor("org.projectlombok:lombok-mapstruct-binding:0.2.0")

	// Tests
	testImplementation("org.springframework.boot:spring-boot-starter-test")
	testImplementation("org.springframework.security:spring-security-test")
	testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
	// @DataJpaTest + TestEntityManager (Spring Boot 4 : module dédié).
	testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test")
	testCompileOnly("org.projectlombok:lombok")
	testAnnotationProcessor("org.projectlombok:lombok")
	testRuntimeOnly("org.junit.platform:junit-platform-launcher")
	// BD embarquée pour les tests JPA (@DataJpaTest) : schéma généré depuis les entités.
	testRuntimeOnly("com.h2database:h2")
	// Testcontainers : IT sur un VRAI Postgres (garde de non-régression du plan de recherche trgm).
	testImplementation("org.testcontainers:junit-jupiter:1.21.4")
	testImplementation("org.testcontainers:postgresql:1.21.4")
	testRuntimeOnly("org.postgresql:postgresql")
}

tasks.withType<Test> {
	jvmArgs("-XX:+EnableDynamicAgentLoading")
}

// Test par défaut : unitaires + @DataJpaTest (H2). On EXCLUT les IT Testcontainers (tag "integration",
// Docker requis) → `./gradlew test` reste rapide et sans Docker. Ils sont lancés par `integrationTest`.
tasks.test {
	useJUnitPlatform {
		excludeTags("integration")
	}
}

// Tests d'intégration (Testcontainers : vrai Postgres). Nécessite Docker.  ./gradlew integrationTest
tasks.register<Test>("integrationTest") {
	description = "Tests d'intégration Testcontainers (vrai Postgres, Docker requis)."
	group = "verification"
	useJUnitPlatform {
		includeTags("integration")
	}
	// Réutilise les classes et le classpath du source set `test`.
	val testSs = sourceSets.test.get()
	testClassesDirs = testSs.output.classesDirs
	classpath = testSs.runtimeClasspath
	shouldRunAfter(tasks.test)
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
	targetClasses = setOf("com.moodit.core_service.*")
	excludedClasses = setOf("*Application", "*.config.*", "*.dto.*", "*.entity.*", "*.model.*")
	excludedTestClasses = setOf("*ApplicationTests", "*IT", "*IntegrationTest*")
	excludedGroups = setOf("integration")
	threads = 4
	outputFormats = setOf("XML", "HTML")
	timestampedReports = false
	timeoutConstInMillis = 8000
	mutationThreshold = 90 // seuil commun aux six services ; score mesuré le 2026-10-23 : 95 %
}
