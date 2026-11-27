import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing for CI/self-hosted builds (docs/mobile.md). The release keystore is NOT in
// the repository; it arrives through four environment variables:
//   CROSSFILE_KEYSTORE_PATH / CROSSFILE_KEYSTORE_PASSWORD / CROSSFILE_KEY_ALIAS / CROSSFILE_KEY_PASSWORD
// When they are absent (local dev), `assembleRelease` still works by falling back to the debug
// signing config — that APK is installable for testing but must NOT be distributed.
val releaseKeystorePath = System.getenv("CROSSFILE_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }
val releaseKeystorePassword =
    System.getenv("CROSSFILE_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
val releaseKeyAlias = System.getenv("CROSSFILE_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val releaseKeyPassword = System.getenv("CROSSFILE_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
val hasReleaseSigning =
    releaseKeystorePath != null &&
        releaseKeystorePassword != null &&
        releaseKeyAlias != null &&
        releaseKeyPassword != null

android {
    compileSdk = 36
    // Pinned so CI only needs platforms;android-36 + build-tools;36.0.0 (no preview 37 package).
    buildToolsVersion = "36.0.0"
    namespace = "org.hancel.file"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "org.hancel.file"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            if (hasReleaseSigning && releaseKeystorePath != null) {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            signingConfig =
                if (hasReleaseSigning) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
