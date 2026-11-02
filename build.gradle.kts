import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    alias(libs.plugins.intellijPlatform)
    alias(libs.plugins.kotlin)
    alias(libs.plugins.kotlinxSerialization)
    alias(libs.plugins.kover)
}

group = "com.adb.stewart"
version = "0.2.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.opentest4j)

    intellijPlatform {
        intellijIdeaCommunity(libs.versions.ideaCommunity)
        testFramework(TestFrameworkType.Platform)
        pluginVerifier()
    }
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        id = "com.adb.stewart"
        name = "Stewart"
        version = project.version.toString()
        description = "Chat with local Ollama models and remote providers inside the IDE."
        vendor {
            name = "ADB"
        }
        ideaVersion {
            sinceBuild = "251"
        }
    }

    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2025.1")
            create(IntelliJPlatformType.PyCharm, "2025.3")
        }
    }
}

kover {
    reports {
        verify {
            rule {
                minBound(90, kotlinx.kover.gradle.plugin.dsl.CoverageUnit.LINE)
                minBound(80, kotlinx.kover.gradle.plugin.dsl.CoverageUnit.BRANCH)
            }
        }
    }
}

tasks {
    check {
        dependsOn("koverVerify")
    }
    test {
        testLogging {
            events("passed", "failed", "skipped")
            showStandardStreams = true
        }
    }
}
