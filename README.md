# QuickListing Connector (Prototype)

> Dealer-facing name: **QuickListing Connector** (the Chrome toolbar / store name).
> Formerly "QuickListing Cookie Bridge" / "QuickListing Bridge" — same extension,
> same stable ID `maioaggefkmlmmomifagahdenaomfcga` (the ID comes from the signing
> key, not the name, so renaming never changes it).
>
> **1.2.0 — account-targeted:** the app now tells the extension WHICH Facebook
> account it posts with (`expectedCUser` on `/bridge/status`). The extension only
> pushes cookies when the browser's active `c_user` matches (or when there's no
> constraint); if the browser is signed into a different FB it reports
> `/bridge/wrong-account` instead of pushing the wrong session, and the app tells
> the dealer to switch. No `c_user` in the browser → nothing shared. So the bridge
> only ever adopts the account the app posts with; the app's `fbMismatchGate` stays
> the final backstop.

Phase 2 of the FB-logout reliability fix. A tiny **companion Chrome extension**
that rescues the logouts the app's cookie vault **cannot** — the ones where
Facebook has **expired/killed the session server-side**, so the app's own
last-known-good cookies are dead. In that case the dealer is usually **still
logged into Facebook in their real Chrome** on the same machine; this extension
hands the app a **fresh live session** over loopback so it can keep posting
without the dealer logging in again.

> **PROTOTYPE — default OFF.** The app side is gated behind
> `flags.sessionExtensionBridge.enabled` (default **off**). Nothing happens until
> a dealer is opted in for A/B. This is a working proof of the mechanism with
> honest security TODOs — not production-hardened.

## How it works

```
Dealer's real Chrome                     QuickListing desktop app
┌─────────────────────────┐              ┌──────────────────────────────┐
│ Cookie Bridge extension │  poll 30s →  │ 127.0.0.1:47615 /bridge/status│
│  (this folder)          │ ← {needed}   │  needed=true only when the    │
│                         │              │  vault restore just failed +  │
│  when needed:true:      │              │  the flag is ON               │
│  read facebook.com      │  POST cookies│                               │
│  cookies + UA  ─────────┼───────────→  │ /bridge/cookies → inject +    │
│                         │              │ align UA + reload + re-probe  │
└─────────────────────────┘              └──────────────────────────────┘
```

- **Pull-on-demand only.** The extension pushes cookies **only** when the app
  says it needs a fresh session — never continuously.
- **Same-machine only.** The app binds `127.0.0.1` (never `0.0.0.0`); the
  extension only ever talks to `http://127.0.0.1:47615`.
- **Full cookie set + UA alignment.** It sends the whole `facebook.com` cookie
  set (`c_user, xs, datr, sb, fr, …`) plus `navigator.userAgent`, and the app
  aligns its FB partition's User-Agent to match — so FB sees the **same device**,
  not a suspicious new browser.
- **Heals session expiry only.** It does **not** clear an account-level
  **checkpoint** — if FB has flagged the account, Chrome's cookies are
  checkpointed too.

## Pairing / auth (prototype)

A single **fixed shared token** authenticates the extension to the app:

- Extension: `TOKEN` in `background.js`
- App: `BRIDGE_TOKEN` in `src/main/facebook/sessionBridge.ts`

They must match (they do, out of the box). The app's receiver rejects any request
without `Authorization: Bearer <token>`.

**TODO (production pairing):**

- App mints a **random per-install token** (not a source constant).
- One-time **consent handshake**: dealer clicks "Pair" / copies a code shown in
  the app; the extension stores the token.
- **Rotate** the token periodically; allow the dealer to revoke.
- Additionally verify the caller is our extension (extension-id/origin allowlist)
  and rate-limit the endpoints.

## Install (load-unpacked)

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `cookie-bridge-extension/` folder.
3. Make sure you're logged into Facebook in that Chrome profile.
4. Open the extension popup — it should show **"Connected to QuickListing ✓"**
   once the desktop app is running (the app's loopback receiver starts at boot).

The extension only ACTS when the app asks (vault restore failed **and** the flag
is on); otherwise it just idles and reports "connected".

## ⚠️ Test-account-first checklist (READ BEFORE ANY REAL DEALER)

This transplants a live FB session between two browser engines. Same-machine it
does **not** add the classic account-lock signals (impossible travel / IP
mismatch) and may even reduce checkpoints (no fresh-device login) — but FB's risk
system is opaque and this is **unproven against live FB**. So prove it on a
throwaway account before it ever touches a real dealer's Facebook.

**Do the whole checklist on a BURNER FB account + a throwaway dealer first:**

- [ ] Use a **disposable Facebook account** you don't care about losing — never a
      real dealer's account for the first run.
- [ ] Extension + app on the **same machine** only. **Never** cross-machine or a
      phone browser (that IS the risky path — IP/device mismatch → lock).
- [ ] Confirm the app's own **cookie vault (`#1`, default-on) works first** on
      this account (watch `fb-session:vault-saved` → clear `c_user` → expect
      `fb-session:restored`, no alert). Only test the bridge once the vault path
      is confirmed.
- [ ] Enable the bridge for **this one test dealer only**
      (`flags.sessionExtensionBridge.enabled = true` from Moon) — everyone else
      stays default-off.
- [ ] Simulate a real server-side logout (invalidate the session server-side, or
      wait for a genuine expiry) and confirm `fb-session:bridge-attempt →
  bridge-restored` with **no** `login_required` alert.
- [ ] **Let it run for ~1 week** on the burner while it posts/scrapes normally.
      Watch for **any** checkpoint, "confirm it's you", or unexpected logout.
- [ ] Watch `fb-session:bridge-failed {reason}` — if `reason` shows checkpoint /
      challenge, that's the account-level lock the bridge **cannot** fix (expected
      limitation, not a bug).
- [ ] Only after a **clean week on the burner** → enable for **one** real
      opt-in dealer, watch closely, then expand gradually.
- [ ] If FB flags the burner at any point → **stop, flip the flag off**, and
      reassess before touching any real account.

**Never skip straight to a valuable dealer.** The whole point of the flag +
same-machine + burner sequence is that a lock only ever risks a throwaway account.

## How we A/B it

1. Ship the app with the bridge **flag off** (default). Collect 1.1.30 telemetry
   to size the split: `fb-session:restored` (vault fixed it, client-side loss)
   vs `fb-session:restore-failed` (dead cookies, server-side — the bridge's
   target population).
2. For a small opt-in cohort, install this extension and flip
   `flags.sessionExtensionBridge.enabled = true` (per-dealer, from Moon runtime
   config — no rebuild).
3. Compare `login_required` alert rate + `fb-session:bridge-restored` vs
   `fb-session:bridge-failed{reason}` for the cohort against control. If the
   bridge meaningfully converts server-side logouts into silent recoveries
   without raising FB-detection signals, graduate it (and do the production
   pairing work above first).

## Telemetry (emitted by the app, not the extension)

`fb-session:bridge-attempt`, `fb-session:bridge-restored`,
`fb-session:bridge-failed {reason}` — on the same `/api/desktop/session-event`
beacon as the vault events. Cookie **values are never logged** anywhere (counts /
presence only).

---

# Phase 3 — Self-hosted force-install (one-button, from the app)

Goal: support/dealer clicks **"Enable browser bridge"** in the app → Chrome/Edge
auto-install this extension from our CDN and auto-update it — **no Developer mode,
no Web Store**.

## ⚠️ Managed vs unmanaged — UNVERIFIED, must be tested

Chrome/Edge **reliably** force-install an **off-store** extension (self-hosted
`update_url`) only on **enterprise-managed** browsers. On **unmanaged consumer**
machines, **recent Chrome may ignore or block** off-store forcelist entries.

**Treat "unmanaged Chrome honors this" as UNPROVEN.** It must be tested on a real
unmanaged dealer machine (see "How to test" below). **If Chrome blocks it, the
fallback is the Chrome Web Store.** Do not tell dealers it works until validated.

## Stable extension ID

```
maioaggefkmlmmomifagahdenaomfcga
```

Derived from the public `key` committed in `manifest.json`, so the ID is
**identical** whether loaded unpacked or installed from the packed CRX. It's also
hard-coded as `COOKIE_BRIDGE_EXT_ID` in
`src/main/facebook/bridgeInstaller.ts` — keep the two in sync.

## Signing key

- **Private key:** `cookie-bridge-extension/key.pem` — **gitignored, never
  committed.** It signs the CRX and defines the ID. **Preserve it in your secret
  store** (a password manager / secrets vault). If you lose it you must
  regenerate (which changes the ID).
- **Public key:** committed in `manifest.json` (`"key"`).
- Regenerate (only if you must): `node pack.mjs --genkey` — writes a new
  `key.pem`, updates `manifest.json "key"`, and prints the **new** ID. Then update
  `COOKIE_BRIDGE_EXT_ID` + this README and re-host.

## Releases (GitHub, canonical repo)

Releases are hosted as **GitHub release assets** on
`YassineCherkaouiV12/quicklisting-bridge`. Each release ships three assets:
`cookie-bridge-<ver>.crx`, `update.xml`, and `quicklisting-bridge-<ver>.zip`.

```bash
# From the repo root (the canonical repo, NOT the stale gemini_desktop copy):
node pack.mjs --bump=minor \
  --cdn=https://github.com/YassineCherkaouiV12/quicklisting-bridge/releases/download/<ver>
#  → dist/cookie-bridge-<ver>.crx
#  → dist/quicklisting-bridge-<ver>.zip
#  → dist/update.xml   (codebase → the <ver> release's .crx download URL)

gh release create <ver> \
  dist/cookie-bridge-<ver>.crx dist/update.xml dist/quicklisting-bridge-<ver>.zip \
  --title "<ver>" --notes "…"
```

### ⚠️ The app config must be updated on EVERY release

`update.xml`'s `codebase` (and its own download URL) is **release-specific**:
`…/releases/download/<ver>/…`. So after each release the app's runtime_config

```
urls.cookieBridgeUpdateUrl = https://github.com/YassineCherkaouiV12/quicklisting-bridge/releases/download/<ver>/update.xml
```

**must be bumped to the new `<ver>` URL** (e.g. `1.1.0` for this release), or Chrome
keeps checking the old release's manifest and never sees the update.
👉 **Coordinator: set `urls.cookieBridgeUpdateUrl` to the 1.1.0 `update.xml` URL
above after this release.**

**TODO (stability):** host `update.xml` at a **stable, version-independent** URL
(e.g. a GitHub Pages / CDN path like `…/quicklisting-bridge/latest/update.xml`, or
the `latest` release download) whose `codebase` is rewritten to the newest CRX on
each release — so the app's `urls.cookieBridgeUpdateUrl` is set **once** and never
has to change per release. Until then it's a manual config bump every release.

The `.crx` must be served with a sane content type (GitHub release assets serve as
`application/octet-stream`) and be publicly GET-able by the dealer's browser.

## Exact policy the app writes (per OS)

The in-app button calls `enableBridgeInstall()` which writes, for each detected
browser (Chrome **and** Edge — same schema):

**Windows** (`HKCU` — no admin needed), key:

```
HKCU\Software\Policies\Google\Chrome\ExtensionSettings\maioaggefkmlmmomifagahdenaomfcga
HKCU\Software\Policies\Microsoft\Edge\ExtensionSettings\maioaggefkmlmmomifagahdenaomfcga
```

REG_SZ values:

```
installation_mode = force_installed
update_url        = <urls.cookieBridgeUpdateUrl>
toolbar_pin       = force_pinned
```

`disableBridgeInstall()` deletes that key (revoke). Policy applies on **Chrome
restart**.

**macOS** (best-effort, **likely NOT applied** — honest caveat): writes
`ExtensionSettings` into the user defaults domain
(`defaults write com.google.Chrome ExtensionSettings -dict-add <ID> …`). Chrome
reads managed policy only from **MDM / a configuration profile**
(`/Library/Managed Preferences/…`), **not** the user domain — so on a plain
non-MDM Mac this will **not** auto-install. Use load-unpacked or the Web Store
there. `bridgeInstallStatus()` reports this honestly.

**Linux:** not automated (managed policy lives in
`/etc/opt/chrome/policies/managed/` and needs root) — load unpacked / Web Store.

## How the button → policy → install chain works

1. App is gated by `flags.sessionExtensionBridge.enabled` (**default OFF**). When
   off, the Settings card is hidden and `enable` is a no-op.
2. Dealer clicks **Enable browser bridge** → `window.api.bridge.enable()` →
   `enableBridgeInstall()` writes the ExtensionSettings policy (HKCU on Windows).
3. App shows **"restart Chrome to finish installing."**
4. On next Chrome/Edge launch, the browser reads the forcelist policy, fetches
   `update_url` (our `update.xml`), downloads the CRX, verifies its signature (ID
   must match `maioaggefkmlmmomifagahdenaomfcga`), and installs + pins it — **if**
   the browser honors off-store force-install (the unverified part).
5. The extension then runs its normal loopback bridge (Phase 1/2).

## How YOU test the force-install on your own machine

1. `node pack.mjs --cdn=<your-cdn>`; upload `dist/*.crx` + `dist/update.xml` to
   `<your-cdn>`; set `urls.cookieBridgeUpdateUrl` to `<your-cdn>/update.xml`.
2. In the app, set `flags.sessionExtensionBridge.enabled = true` (runtime config),
   open **Settings → Browser bridge → Enable**.
3. **Fully quit and reopen Chrome.** Go to `chrome://extensions` — check whether
   "QuickListing Cookie Bridge" appears as **force-installed** (and
   `chrome://policy` → Reload policies shows the `ExtensionSettings` entry).
4. **If it installs:** unmanaged force-install works on your Chrome — proceed to a
   wider A/B. **If it does NOT** (policy shows but extension is blocked/ignored):
   that confirms the unmanaged-Chrome limitation → fall back to publishing on the
   **Chrome Web Store** and force-installing by Web Store ID instead.
