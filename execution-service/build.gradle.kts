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
	// Web (REST entrant + RestClient sortant vers Piston)
	implementation("org.springframework.boot:spring-boot-starter-webmvc")

	// Sécurité (pose l'Authentication à partir de X-User-Email injecté par le gateway)
	implementation("org.springframework.boot:spring-boot-starter-security")

	// Validation des payloads d'évaluation
	implementation("org.springframework.boot:spring-boot-starter-validation")

	// Runner Docker des langages compilés (#116) : client API Docker (transport zerodep :
	// socket Unix en prod/conteneur, named pipe en dev Windows) + tar en mémoire des jobs.
	// BouncyCastle exclu (CVE critique en 1.76, bloquante pour Trivy) : il ne sert qu'à
	// l'authentification TLS d'un démon distant (DOCKER_CERT_PATH), jamais utilisée ici —
	// on parle au démon local par socket/named pipe. Guava forcé : la 19.0 transitive a une
	// CVE DoS (fixée en 33.x).
	implementation("com.github.docker-java:docker-java-core:3.4.1") {
		exclude(group = "org.bouncycastle")
	}
	implementation("com.github.docker-java:docker-java-transport-zerodep:3.4.1")
	implementation("org.apache.commons:commons-compress:1.27.1")
	constraints {
		implementation("com.google.guava:guava:33.7.2-jre") {
			because("CVE-2026-102554 : DoS via la 19.0 transitive de docker-java-core")
		}
	}

	// Lombok
	compileOnly("org.projectlombok:lombok")
	annotationProcessor("org.projectlombok:lombok")

	// Tests
	testImplementation("org.springframework.boot:spring-boot-starter-test")
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
// sur main, pas sur chaque PR (plusieurs minutes). Tests exigeant Postgres ou Piston exclus.
pitest {
	pitestVersion = "1.30.1"
	junit5PluginVersion = "1.2.3"
	targetClasses = setOf("com.moodit.execution_service.assembly.*", "com.moodit.execution_service.service.*", "com.moodit.execution_service.piston.*", "com.moodit.execution_service.sandbox.*")
	// DockerSandbox = enveloppe d'infra (client Docker) : couverte par DockerRunnerIntegrationTest
	// (exclu de PIT comme toute intégration), pas par les tests unitaires → on ne la mute pas.
	excludedClasses = setOf("com.moodit.execution_service.sandbox.DockerSandbox")
	excludedTestClasses = setOf("*ApplicationTests", "*ExecutionIntegrationTest", "*DockerRunnerIntegrationTest")
	threads = 4
	outputFormats = setOf("XML", "HTML")
	timestampedReports = false
	mutationThreshold = 90 // seuil commun aux six services ; score mesuré le 2026-10-25 : 96 %
}
