package com.adb.stewart.host

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe

/** HostPort secrets on PasswordSafe; one attribute per secret ref. */
class SecretStore(private val safe: PasswordSafe = PasswordSafe.instance) {
    private fun attrs(ref: String) = CredentialAttributes(generateServiceName("Stewart", ref))

    fun get(ref: String) = safe.get(attrs(ref))?.getPasswordAsString()

    fun set(ref: String, value: String) {
        safe.set(attrs(ref), Credentials(ref, value))
    }

    fun delete(ref: String) {
        safe.set(attrs(ref), null)
    }
}
