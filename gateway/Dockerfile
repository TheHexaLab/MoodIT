# Build stage
FROM eclipse-temurin:25-jdk AS builder
WORKDIR /app
COPY gradlew ./
COPY gradle ./gradle
# Fins de ligne de gradlew : `sed`, et NON `apt-get install dos2unix`. Cette installation
# etait une dependance RESEAU sur le chemin critique de la CI et du deploiement : une panne
# DNS du runner (archive.ubuntu.com non resolu) faisait echouer la construction des six
# images, sans qu'une ligne du depot ait change. `.gitattributes` garantit deja LF partout
# (`* text=auto eol=lf`), et `sed` est dans l'image de base — la normalisation ne reste donc
# que comme filet, pour des sources recues hors de git (archive produite sous Windows).
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew
COPY build.gradle.kts settings.gradle.kts ./
RUN ./gradlew dependencies --no-daemon
COPY src ./src
RUN ./gradlew bootJar --no-daemon

# Run stage
FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]