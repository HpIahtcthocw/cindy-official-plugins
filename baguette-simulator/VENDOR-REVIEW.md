# Vendored runtime evidence

Upstream: [tddworks/baguette v0.2.7](https://github.com/tddworks/baguette/releases/tag/v0.2.7), macOS arm64 release (Apache-2.0, © tddworks). Original release archive SHA-256: `af95902bd11eb1e81309a697c863b5b25698aae480da1d67b8e9db178343b8c3`, matching the GitHub asset digest (checked 2026-10-19). The two native executables are rebuilt from the official source with the patch documented below; `vendor-inventory.json` enumerates all 102 packaged upstream files with SHA-256 and byte size. The release Web folder is byte-identical to the tagged source. Since 0.1.24 the plugin icon is Cindy's own iOS Simulator icon; the Baguette logo is no longer shipped.

## Exact source modifications

`vendor-web.patch` is the complete diff, with context, against `Sources/Baguette/Resources/Web` at tag v0.2.7 (official release archive Web resources). These ten Web files differ (nine carried-forward patches, the reviewed Duo edge-drag fix, and the 0.2.7 Defaults toggle removal):

- `stream-session.js`: bounded reconnect after unexpected socket close; cancel scheduled reconnect on deliberate stop.
- `baguette/parts/keyboard.js`: delegate key/text/clipboard actions to the same-origin /clipboard private-device bridge (fragment port never selects a destination), suppress OS repeats and duplicate in-flight paste, serialize keys/paste/copy, report queue overflow with English fallback for added input errors, drop unsent keys on blur/hide/detach/release.
- `baguette/parts/bezel.js`, `baguette/carplay/carplay-frame.js`, `sim-native.html`: standard arrow cursor instead of crosshair.

- `farm/farm.html`: remove remote font/preconnect links; keep the existing system-font fallback and all Device Farm controls.
- `sim-location.js`: map tiles/search use same-origin `/map/` routes; the Node worker validates coordinates/query length and sends HTTPS only to fixed OSM hosts, with no redirects or forwarded credentials.
- `sim-native.js`: toolbar labels use textContent, preserving literal text instead of interpreting DOM-sourced titles as HTML.
- `sim-3d.js`: fallback selector escaping uses CSS hexadecimal escapes for every code point, including backslashes and quotes.

The first-party `native/keyboard.m` adapts Baguette’s SimulatorKit ABI and device resolution (Apache-2.0); its source and `native/build.sh` accompany the ad-hoc signed Apple Silicon binary. It waits for every delivery completion, releases keys on partial failure, refuses a foreign/default device set and serializes helper access using a per-device lock. It does not restart SpringBoard or extract clipboard/account contents.

- `sim-native.html`, `sim-native.js` (0.2.7): remove the Defaults card toolbar button and its overflow-menu row. The card scripts stay unchanged but cannot be opened; `node/viewer-proxy.cjs` returns 404 for its routes (see the 0.2.7 review).

## Outbound-domain and execution scan

Source URL scan of all vendor JS/HTML/CSS/JSON identified:

- `nominatim.openstreetmap.org`, `tile.openstreetmap.org`: pre-existing optional location search and map tiles (`sim-location.js`). User-triggered functionality now routed through the autonomous Node worker fixed endpoints; browser requests stay same-origin.
- `fonts.googleapis.com`, `fonts.gstatic.com`: removed from `farm/farm.html`; existing CSS system-font fallbacks are used without font downloads.
- `leafletjs.com`: library attribution; `bugs.chromium.org`, `bugzilla.mozilla.org`: CSS comment references; `www.w3.org`: SVG namespace constant. These are not added runtime API clients.
- `127.0.0.1`: the added clipboard bridge; exact Origin and random capability required, request body capped at 40 KB, no clipboard content logging.

No eval/new Function calls or added executable base64 blobs were found in the ten modified upstream files or first-party Node/native code. Leaflet contains its upstream embedded transparent GIF and CSS assets; no executable payload was added. The full Baguette binary includes more upstream capabilities than the 16 exposed Agent tools: this PR does not claim to audit every native feature by reading JavaScript. Native binary and new plugin admission require maintainer review; the runtime’s own private-framework ABI is not a stable Apple API.

The plugin declares Node and loopback preview, uses fixed executable paths and argument arrays (never shell interpolation), no managed credentials, and launches Baguette with `--no-plugins`. Simulator apps retain their own network/auth state; App input may still trigger external actions. No command download occurs at runtime. Dependency licenses from the upstream tag’s Package.resolved (including build/test-only packages) and Leaflet 1.9.4 are reproduced in THIRD-PARTY-LICENSES.txt.

## Known limits and verification boundary

Native WebSocket disconnect SIGABRT was observed with 0.1.98; its status with 0.2.7 is not yet device-verified, so bounded recovery is preserved. Worker shutdown also stops the controller. Browser session ownership is separate from persistent simulator data. Historical tests cover the bridge and real iOS 27 native input. The installed 0.2.0 candidate checks and the 0.2.7 local smoke are recorded below and in VERIFICATION.json.

The proxy bootstraps an HttpOnly SameSite=Strict capability cookie only from a token-authenticated control request. All proxied viewer HTTP, map and WebSocket routes require it; credentials are stripped before HTTP forwarding. The empty controller shell is public so its fragment can authenticate. This protects the proxy, not against same-user processes that can access CoreSimulator or the upstream Baguette loopback listener directly. Manual restart excludes only the retired child from crash accounting.

Minimum OS evidence: `xcrun vtool -show-build` reports `LC_BUILD_VERSION minos 15.0` for both bundled Baguette and native/keyboard. The worker checks `/usr/bin/sw_vers -productVersion` before launching either binary and rejects older or unrecognized versions with UNSUPPORTED_OS.

Viewer transport boundary: these scripts run in the external page opened by `cindy.preview`, not the plugin sandbox/Panel. Keyboard requests use relative `/clipboard` on that already-open preview origin; no hostname or port is chosen from input. `main.js` uses `cindy.node.request` to start the declared Node runtime and `cindy.preview` to open its declared preview host. The page has no `cindy.fetch` API. External OSM requests remain in fixed-endpoint Node code.

Native helper update: releaseKeys submits HID usages 4–231 before waiting once on a dispatch group, with a shared one-second acknowledgment deadline. Missing callbacks no longer prevent subsequent key-up submission. A serial callback queue aggregates delivery failures; timeout returns failure without reading mutable callback state, and late callbacks retain their resources. Rebuilt with `sh native/build.sh` and verified ad-hoc signature. Updated native/keyboard SHA-256: `96a8eeb56f41ab6bab253e96a2e85398f9d7009f8a50cf250dbfc48dc4c623fd`. The macOS Objective-C regression compiles the production functions and uses actual dispatch queues, covering first/middle/last/all errors, no callbacks and delayed callbacks; it confirms all 228 submissions and a timeout under three seconds. This native regression is explicitly skipped on non-macOS runners. The keyboard helper binary is unchanged by the 0.2.0 upgrade; its Duo Unicode input was verified in the installed Cindy Beta package.

## 0.2.0 upgrade review (2026-09-26)

- Official release: https://github.com/tddworks/baguette/releases/tag/v0.2.0 . Nine existing Web patches were reapplied. Baguette and HingeControl were rebuilt from the official tag with `vendor-native.patch`, covering the private-set compatibility problems reproduced below.
- `Package.resolved` is byte-identical between v0.1.98 and v0.2.0. Dependency licenses and the existing logo attribution are retained. Baguette's host executable still declares macOS 15.0 as its minimum.
- New execution: upstream `GuestHingeMotor` installs the bundled HingeControl executable into its content-addressed local cache and spawns it inside the selected simulator via `xcrun simctl spawn`. It registers virtual HID services and dispatches hinge and hardware-button events. This is shipped code, not a network download. It persists while the serving process owns it. The viewer now exposes real device pose changes; descriptions in all four locales disclose their effect on the foreground app.
- New asset resolution reads `V68.usdz` from the selected Xcode DeviceKit resource path. The shipped Duo model definition has null downloadURL/file/sha256; no new remote model endpoint. Reviewed the new `xcodeResource` branch of VerifiedDeviceAssets and the Duo definition. Existing non-Duo model/download behavior is unchanged.
- New Web behavior: hinge/3D/panel messages and pose updates use the authenticated existing loopback proxy. No new external domains or credentials are introduced. Existing no-plugins launch, OSM proxy, remote-font removal, keyboard queue, capability cookie and reconnect controls remain.
- The first-party clipboard path now mirrors the upstream CoreDevice-first write with a private-set simctl fallback, preserving stdin transport and keyboard delivery acknowledgements. Regression cases cover successful Unicode writes, old-Xcode fallback, write failure without stale paste, and rejection of foreign devices.
- Native compatibility fixes: `DeviceHost.deviceSetPath` carries the selected set into `SimctlIOCapture` and `GuestHingeMotor`; Foundation Process argv remains an array. `DevicectlHinge` uses the bundled HingeControl monitor for custom sets because CoreDevice cannot discover those devices. Its monitor dynamically loads the system CoreMotion framework and reads CMAngleManager sensor updates; angles come from the guest, never the requested command. The child timeout is bounded to 1–86400 seconds, and cancellation terminates its process. No new network, credential or dynamic-download path is added.
- Model matching accepts CoreSimulator's stable display type name as well as the identifier and user name. A renamed Duo previously returned no model. It now resolves the same Xcode-local model.
- simctl clipboard fallback explicitly uses UTF-8 locale. The installed worker otherwise inherited an ASCII locale and rejected Chinese stdin; the fixed path was checked against guest pasteboard and visible Settings search.
- Official source archive SHA-256: `5414809d0217a128a99508f7d9a36e8ab5da524125c3180e86bdc509cf948559` (`https://api.github.com/repos/tddworks/baguette/tarball/v0.2.0`). `native/build-baguette.sh` verifies this archive, applies the shipped patch, builds with pinned Package.resolved, and copies only the two rebuilt executables. Full inventory records the packaged bytes. The native patch includes motor routing and renamed-model regressions.
- Installed-client checks: Cindy 0.1.93 Beta, Xcode 27.1 beta (27A9269), iOS 27.1 (24A94401), private Duo. Actual sidebar pixels confirmed 0° and 130° pose rendering. Touch navigated Settings; Unicode input rendered Duo测试 once. Xcode 26 integration and exhaustive viewer features are not claimed.

## 0.2.7 upgrade review (2026-10-19)

- Official release: https://github.com/tddworks/baguette/releases/tag/v0.2.7 . Official source archive SHA-256: `c7a3003515af13c752af5cdbb8846cbf6dc0b819c3645f6b98e17951a4927771` (`https://api.github.com/repos/tddworks/baguette/tarball/v0.2.7`); `native/build-baguette.sh` verifies it. `Package.resolved` is byte-identical to v0.2.0, so dependency licenses are unchanged.
- No URL or host literal was added or removed in Swift, Objective-C, Web, JSON or shell sources; no new download, eval/new Function or credential handling.
- Native patch rebased. Upstream now passes the selected device set to `GuestHingeMotor`, `SimctlCapture`, `HostExternalDisplays`, `GuestFrontmost` and `SimctlCameraGuest`, and matches renamed devices by stable device type, so those hunks were dropped. Remaining changes: the read-only HingeControl `monitor` (CoreMotion `CMAngleManager`, before any HID service), `DevicectlHinge` reading it through `simctl --set … spawn` for custom sets (CoreDevice cannot discover them), the new observed-screen sample in `SimulatorKitDisplay` using the same set, and the 0.2.7 version stamp. A DevicectlHinge regression covers the argv. The full upstream suite (2449 tests) passes with the patch. Upstream main #117 (after v0.2.7) implements the same guest read; drop this patch once a release contains it.
- DefaultsLookups (new): a dylib that swizzles NSUserDefaults getters and writes looked-up keys and registered defaults to `/tmp/BaguetteLookups-<UDID>-<bundle>.plist`; injected only by Baguette's own `simctl launch` (Defaults card relaunch). The new `/simulators/:udid/{defaults,defaults.json,defaults-groups.json,apps.json,relaunch}` routes read or rewrite any app's UserDefaults (which may contain tokens) and ignore the private device set. The plugin does not bundle the dylib, removes the toolbar entry, and its proxy returns 404 for those routes after percent-decoding and slash collapsing; the CLI `defaults --file` import is never invoked.
- HingeControl adds `frontmost` (read-only AX, adapted from facebook/idb under MIT; `LICENSE.idb` ships beside the binary and in THIRD-PARTY-LICENSES.txt), `--deadline` and `done <status>` replies. On timeout the host kills the helper by its reported guest pid (upstream behavior).
- Web: new Handheld mode (`localStorage` for button position only) and Defaults card files escape app-controlled strings with `esc()` in double-quoted attributes or text; no new external resources, `window.open` or `postMessage`.
- VirtualCamera, VirtualMotion and VirtualNetwork sources are unchanged; the existing tracked dylibs (the tagged source's committed builds) are kept byte-for-byte. Models, plugins and the nine USDZ files are byte-identical to the v0.2.7 release; `binary-dependencies.json` now pins that archive.
- Local smoke (2026-10-19, Xcode 27.1 27A9269, private-set iPhone Duo on iOS 27.1): `--version` 0.2.7, `hinge` read 0° through the guest monitor, `describe-ui`, `screenshot` and `serve` (`/simulators`, device page, `/hinge`) succeeded with the LTO build. Installed-package verification in Cindy Beta remains a separate PR gate.

## Repository binary-size gate

The unchanged nine USDZ files are portable model data, selected by exact path from the same SHA-pinned official archive through `binary-dependencies.json`. Only these resources use the shared-platform declaration; no native executable or dylib is declared portable. All model bytes remain in the self-contained package, with no runtime download. Native code remains explicitly macOS arm64-only. The stable `vendor/baguette/` path avoids version-directory churn.

The host release binary is built with whole-program LTO (`--experimental-lto-mode=full`) and Swift `-Osize`, stripped with the standard Xcode tool and ad-hoc signed; no feature is removed. LTO brings 0.2.7 from 9.86 MB to 7.94 MB, so tracked binaries total about 8.95 MB. `native/build-baguette.sh` records these exact steps. The source tag retains a stale `baguetteVersion` constant (0.1.61); the shipped source patch stamps 0.2.7 so `environment` reports the actual upstream version. The 10 MiB repository gate and six-platform dependency rule are unchanged.

## Review follow-up

`screen-pieces.js` chooses the closest rendered quad for off-screen drag coordinates, preserving the appropriate Duo half instead of always using piece zero. Tests exercise both halves, reversed piece order, single-screen and empty-screen input. The private-set clipboard fallback reads back exact UTF-8 bytes with `simctl pbpaste` before Command-V; mismatch or unreadable contents return `unknown` without pasting. Readback preserves whitespace and never includes clipboard contents in failure messages.

Live `screen_quad.litPanel` changes now notify the page input mapper, synchronizing primary/portrait and secondary/landscape-left before subsequent taps or drags. Duplicate metadata preserves manual rotation; obsolete stream callbacks are rejected. The callback survives model/retry attachment. A production-stream/page-mapper regression covers opening, closing, manual rotation, invalid panel names and stale streams.

Panel-switch synchronization also updates `Sim3DPanel.interfaceOrientation` through its existing setter, so subsequent camera messages and the page rotation cycle agree. The regression exercises actual camera serialization after manual rotation and folding, including a later camera update that must not restore the old orientation.
