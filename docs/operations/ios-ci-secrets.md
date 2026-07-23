# iOS CI Build — Required GitHub Secrets

The `.github/workflows/build-field-ios.yml` workflow builds and signs an iOS
`.ipa` for the RFID field app on a GitHub-hosted macOS runner, then deploys it
to Vercel Blob for in-house (`itms-services`) install. It is a **single
environment** — there is no dev/prod split.

| Bundle ID | Marketing version | Build number | Trigger |
|---|---|---|---|
| `com.brasfieldgorrie.rfid-field` | `app.json` `expo.version` | GitHub run number | push to `main` / `rewrite/expo` (field-touching paths), manual dispatch |

> Why enterprise in-house and not TestFlight / EAS: the org can't use TestFlight
> for this app. We sign with B&G's Apple Developer Enterprise cert and
> distribute the IPA ourselves via a web install page + `manifest.plist`. See
> `plans/010-sync-ops-import-cutover.md` Phase 5 and
> `docs/operations/sync-security-decision.md`.

## Required repository secrets

Set these at **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**.

| Secret name | Contents |
|---|---|
| `IOS_DIST_CERT_BASE64` | base64-encoded `.p12` of the **iPhone Distribution: Brasfield & Gorrie, LLC** certificate (must include the private key). |
| `IOS_DIST_CERT_PASSWORD` | The password used when exporting the `.p12` above. |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64-encoded `.mobileprovision` for App ID `com.brasfieldgorrie.rfid-field`. |
| `BLOB_READ_WRITE_TOKEN` | The web app's `rfid-bol` Vercel Blob store read-write token (used by the deploy job to upload the IPA + `latest.json`). |

> Who can produce the cert: Scott Coleman (or whoever holds the iPhone
> Distribution cert's private key). The provisioning profile can be downloaded
> by anyone with **App Manager + cert/profile access** on the Apple Developer
> team, including from the portal UI.

## Apple Developer portal setup (one-time)

The App ID must exist in the portal:
<https://developer.apple.com/account/resources/identifiers>

- `com.brasfieldgorrie.rfid-field` — RFID Field

If you're using the existing **BG Wildcard** profile (covers
`com.brasfieldgorrie.*`), it can sign this app — but for traceability and the
ability to revoke independently, a dedicated profile is recommended.

## How to obtain each secret

### 1. The Distribution certificate `.p12`

On the Mac that holds the cert's private key (Scott's, currently):

1. Open **Keychain Access** → **login** keychain → **My Certificates**.
2. Find **`iPhone Distribution: Brasfield & Gorrie, LLC`**.
3. Click the disclosure triangle ▶ to confirm a private key is shown beneath.
   **No private key = useless export.**
4. Right-click → **Export "iPhone Distribution…"**.
5. File format: **Personal Information Exchange (.p12)**.
6. Pick a strong password — this becomes `IOS_DIST_CERT_PASSWORD`.
7. Save as `rfid-field-distribution.p12`.

Encode to base64 (clipboard):

```bash
base64 -i rfid-field-distribution.p12 | pbcopy
```

Paste as `IOS_DIST_CERT_BASE64`.

### 2. The provisioning profile

1. Visit <https://developer.apple.com/account/resources/profiles>.
2. Either pick the existing profile for `com.brasfieldgorrie.rfid-field` or create one:
   - **Type**: Universal Distribution (matches the workflow's `enterprise`
     export method for ADEP).
   - **App ID**: `com.brasfieldgorrie.rfid-field`.
   - **Certificate**: select the `iPhone Distribution: Brasfield & Gorrie, LLC` cert.
3. Click **Download** to get the `.mobileprovision`.

Encode:

```bash
base64 -i RFID_Field.mobileprovision | pbcopy
# → paste as IOS_PROVISIONING_PROFILE_BASE64
```

> The workflow inspects the profile after decoding and **fails loudly** if the
> profile's `application-identifier` entitlement doesn't end with the expected
> bundle ID. Catches the easy "uploaded the wrong file" mistake before
> xcodebuild gets involved.

### 3. The certificate password

The password you set in step 1. No encoding — paste as-is into
`IOS_DIST_CERT_PASSWORD`.

### 4. The Blob read-write token

1. Open the Vercel project for the web app → **Storage** → the `rfid-bol` Blob
   store.
2. Copy the **Read and Write** access token.
3. Paste as `BLOB_READ_WRITE_TOKEN`.

> This is the same token the web app's `/api/bol/upload-grant` route uses to
> mint presigned PUT/GET URLs for BOL artifacts. The deploy job reuses the same
> private store for the IPA: the IPA is uploaded with `access: 'private'` and
> served to iOS at install time via a short-lived presigned GET URL minted by
> the `/api/field/manifest.plist` route. The read-write token never leaves the
> server / CI.

## Verifying the secrets work

Once all four secrets are set, trigger a build manually:

1. **Actions** tab on GitHub.
2. **Build Field iOS** workflow.
3. **Run workflow** → Run.

The build takes ~15–25 minutes on `macos-15-xlarge`. The `.ipa` lands in the
run's **Artifacts** section as `rfid-field-<run-number>-ios`, and the deploy
job uploads it to Blob + writes `field-ios/latest.json`. After deploy, the
`/field/install` page and `/api/field/manifest.plist` route serve the OTA
install; the field app's version check will show the update banner on the next
foreground.

## Rotating secrets

### Certificate (expires 2027-07-26)

> ⚠️ **Cert expiry kills installed apps.** When the iPhone Distribution cert
> expires, every installed field app stops launching until it is re-signed and
> reinstalled. Put cert renewal on the maintenance calendar well before
> 2027-07-26 (treat 2027-04 as the action date: renew, rebuild, redeploy, and
> have operators re-install before the old cert lapses).

When the cert expires (or to rotate early), the cert holder needs to:

1. Generate a new `iPhone Distribution` certificate in the portal.
2. Re-export as `.p12` with a new password.
3. Re-encode to base64 and update both `IOS_DIST_CERT_BASE64` and
   `IOS_DIST_CERT_PASSWORD`.
4. Re-link the new cert to the provisioning profile (portal: Profiles → the
   RFID Field profile → Edit → pick new cert → Save → Download).
5. Re-encode the regenerated `.mobileprovision` and update
   `IOS_PROVISIONING_PROFILE_BASE64`.
6. Trigger a new build so a cert-fresh IPA is deployed and operators re-install.

### Provisioning profile (expires ~1 year after creation)

When the profile expires:

1. Portal → Profiles → the expired one → **Edit** → **Save** (Apple re-issues
   with fresh expiration).
2. **Download** the new `.mobileprovision`.
3. `base64 -i <file> | pbcopy` and update `IOS_PROVISIONING_PROFILE_BASE64`.

Renewal alone doesn't require touching the cert.

## What this workflow does NOT need

- ❌ No `EXPO_TOKEN` — we don't talk to EAS.
- ❌ No App Store Connect API key — we don't submit to TestFlight.
- ❌ No Apple ID credentials in CI — signing uses the imported `.p12` directly.
- ❌ No Intune / Company Portal — US distribution is the web install page, not MDM.

## iOS 18+ first-install caveat

First install on iOS 18+ requires the operator to manually trust the enterprise
developer in **Settings → General → VPN & Device Management → Brasfield & Gorrie,
LLC → Allow & Restart**, and the device must reach `ppq.apple.com` for the trust
check. The `/field/install` page walks the operator through this; it only needs
to happen once per device. See the install page and Phase 5 notes in the plan.
