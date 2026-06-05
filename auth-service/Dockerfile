# Build stage
FROM eclipse-temurin:25-jdk AS builder
WORKDIR /app
COPY gradlew ./
COPY gradle ./gradle
RUN apt-get update && apt-get install -y dos2unix && dos2unix gradlew && chmod +x gradlew
COPY build.gradle.kts settings.gradle.kts ./
RUN ./gradlew dependencies --no-daemon
COPY src ./src
RUN ./gradlew bootJar --no-daemon

# Run stage
FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
EXPOSE 8083
ENTRYPOINT ["java", "-jar", "app.jar"]