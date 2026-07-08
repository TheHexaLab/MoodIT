plugins {
	java
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
