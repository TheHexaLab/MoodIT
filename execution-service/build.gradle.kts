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
	targetClasses = setOf("com.moodit.execution_service.assembly.*", "com.moodit.execution_service.service.*", "com.moodit.execution_service.piston.*")
	excludedTestClasses = setOf("*ApplicationTests", "*ExecutionIntegrationTest")
	threads = 4
	outputFormats = setOf("XML", "HTML")
	timestampedReports = false
	mutationThreshold = 90 // seuil commun aux six services ; score mesuré le 2026-10-25 : 96 %
}
