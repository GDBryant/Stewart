import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask

plugins {
    alias(libs.plugins.intellijPlatform)
    alias(libs.plugins.kotlin)
    alias(libs.plugins.kotlinxSerialization)
    alias(libs.plugins.kover)
}

group = "com.adb.stewart"
version = providers.gradleProperty("version").orNull ?: "2.0.0"

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
        intellijIdea(libs.versions.ideaCommunity)
        testFramework(TestFrameworkType.Platform)
        pluginVerifier()
    }
}

kotlin {
    jvmToolchain(21)
}

sourceSets {
    main {
        kotlin.srcDir("hosts/jetbrains/src/main/kotlin")
        resources.srcDir("hosts/jetbrains/src/main/resources")
    }
    test {
        kotlin.srcDir("hosts/jetbrains/src/test/kotlin")
    }
}

/** Copy the built webview bundle and sidecar into the plugin resources. */
val syncWebview by tasks.registering(Copy::class) {
    from("packages/webview/dist")
    into(layout.buildDirectory.dir("generated/resources/webview"))
}

val syncSidecar by tasks.registering(Copy::class) {
    from("packages/sidecar/dist") { include("sidecar.cjs") }
    into(layout.buildDirectory.dir("generated/resources/sidecar"))
}

/** Per-OS bundled Node binaries staged by scripts/bundle-node.mjs into dist/node/<os>-<arch>/. */
val syncNode by tasks.registering(Copy::class) {
    from("dist/node")
    into(layout.buildDirectory.dir("generated/resources/node"))
}

sourceSets.main {
    resources.srcDir(layout.buildDirectory.dir("generated/resources"))
}

tasks.processResources {
    dependsOn(syncWebview, syncSidecar, syncNode)
}

intellijPlatform {
    pluginConfiguration {
        id = "com.adb.stewart"
        name = "Stewart"
        version = project.version.toString()
        description = "Chat with local and remote models inside the IDE: roles, skills, orchestration and tools."
        vendor {
            name = "ADB"
        }
        ideaVersion {
            sinceBuild = "261"
        }
    }

    pluginVerification {
        ides {
            create(IntelliJPlatformType.IntellijIdea, "2026.1")
            create(IntelliJPlatformType.PyCharm, "2026.2")
        }
    }

    signing {
        val chain = providers.environmentVariable("CERTIFICATE_CHAIN").orNull
        val key = providers.environmentVariable("PRIVATE_KEY").orNull
        val pass = providers.environmentVariable("PRIVATE_KEY_PASSWORD").orNull
        if (chain != null && key != null) {
            certificateChain.set(chain)
            privateKey.set(key)
            pass?.let { password.set(it) }
        }
    }
}

kover {
    reports {
        filters {
            excludes {
                // IDE glue not exercisable headless: JCEF panel, tool window, action, service shell.
                // Logic inside them lives in SidecarWiring / WebviewRouter / host.*, which are covered.
                classes(
                    "com.adb.stewart.webview.StewartPanel",
                    "com.adb.stewart.webview.StewartPanel$*",
                    "com.adb.stewart.StewartToolWindowFactory",
                    "com.adb.stewart.StewartProjectService",
                    "com.adb.stewart.StewartProjectService$*",
                    "com.adb.stewart.actions.*",
                )
            }
        }
        verify {
            rule {
                minBound(90, kotlinx.kover.gradle.plugin.dsl.CoverageUnit.LINE)
                minBound(80, kotlinx.kover.gradle.plugin.dsl.CoverageUnit.BRANCH)
            }
        }
    }
}

tasks {
    withType<VerifyPluginTask>().configureEach {
        failureLevel.set(listOf(VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS))
    }
    check {
        dependsOn("koverVerify")
    }
    test {
        if (providers.gradleProperty("e2e").isPresent) include("com/adb/stewart/e2e/**") else exclude("com/adb/stewart/e2e/**")
        testLogging {
            events("passed", "failed", "skipped")
            showStandardStreams = true
        }
    }
}
