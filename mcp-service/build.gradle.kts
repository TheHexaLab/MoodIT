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

dependencies {
	// Web (REST + RestClient sortant vers Ollama et le pont WS interne de core-service)
	implementation("org.springframework.boot:spring-boot-starter-webmvc")

	// Données (base PARTAGÉE avec core-service ; mcp-service n'écrit que mcp_response)
	implementation("org.springframework.boot:spring-boot-starter-data-jpa")
	runtimeOnly("org.postgresql:postgresql")

	// Sécurité (pose l'Authentication à partir de X-User-Email injecté par le gateway)
	implementation("org.springframework.boot:spring-boot-starter-security")

	// Validation
	implementation("org.springframework.boot:spring-boot-starter-validation")

	// Lombok
	compileOnly("org.projectlombok:lombok")
	annotationProcessor("org.projectlombok:lombok")

	// Tests
	testImplementation("org.springframework.boot:spring-boot-starter-test")
	testImplementation("org.springframework.security:spring-security-test")
	testRuntimeOnly("com.h2database:h2") // BD embarquée pour les tests JDBC (CourseStatsRepository)
	testCompileOnly("org.projectlombok:lombok")
	testAnnotationProcessor("org.projectlombok:lombok")
	testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
	jvmArgs("-XX:+EnableDynamicAgentLoading")
}

// Test par défaut : exclut l'éval LLM (opt-in, nécessite Ollama + non déterministe).
tasks.test {
	useJUnitPlatform { excludeTags("llm-eval") }
}

// Harnais d'éval du prompt LLM : ./gradlew llmEval  (cf. LlmAnalysisEvalIT pour les prérequis).
tasks.register<Test>("llmEval") {
	description = "Éval du prompt d'analyse contre un vrai Ollama (opt-in, non déterministe)."
	group = "verification"
	// Réutilise les classes et le classpath du source set `test` (sinon NO-SOURCE).
	val testSs = sourceSets.test.get()
	testClassesDirs = testSs.output.classesDirs
	classpath = testSs.runtimeClasspath
	useJUnitPlatform { includeTags("llm-eval") }
	outputs.upToDateWhen { false }          // toujours relancer
	testLogging { showStandardStreams = true } // afficher le scorecard imprimé
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
	targetClasses = setOf("com.moodit.mcp_service.*")
	excludedClasses = setOf("*Application", "*.config.*", "*.dto.*", "*.entity.*", "*.model.*")
	excludedTestClasses = setOf("*ApplicationTests", "*IT", "*IntegrationTest*")
	excludedGroups = setOf("integration")
	threads = 4
	outputFormats = setOf("XML", "HTML")
	timestampedReports = false
	timeoutConstInMillis = 8000
	mutationThreshold = 87 // score mesuré le 2026-10-23 : 90 % ; ne jamais baisser
}
