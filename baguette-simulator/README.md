# iOS Simulator

[简体中文](README.zh-CN.md)

Cindy's official iOS simulator for Apple Silicon Macs, using bundled Baguette 0.2.10. It replaces the retired embedded simulator; Cindy shows previous users a one-time migration notice pointing here (plugin id `baguette-simulator`).
Requires macOS 15.0+, Apple Silicon, Cindy 0.1.83+, full Xcode and an installed iOS runtime. No first-run dependency download. Packaging collects nine portable USDZ model assets from the hash-pinned official release via `binary-dependencies.json`; the native executables remain tracked and macOS-only.

Use it by default for iOS Simulator tasks. Run `environment` and `devices`, reuse a suitable logged-in device, then `boot` if needed. Build the App with the project’s normal Xcode workflow; use `install_app` and `launch_app` for its already-built Simulator `.app`. `launch_app` opens the current task's simulator tab by default. Check `viewer.previewOpened`; a running process does not prove a visible preview. Reopen an existing device with `open_viewer` after changing sessions.

Two views: each task gets its own **iOS Simulator** tab in the right sidebar (screen and controller only, no address bar), and **Simulators** in the left navigation manages every device regardless of task (start, shut down, rename, new iPhone, open in the current task) and shows how many tasks use each one. Which device a task uses is decided when the AI opens the simulator: `devices` rows carry `tasks` and `thisTask`, so it can reuse a free device or create one; `boot`, `open_viewer` and `launch_app` bind the device to the calling task (`~/Library/Application Support/BaguetteCindy/task-bindings.json`, mode 0600). Without a task tab (no device yet, or the device is off) the tab offers the device list or Start instead of a blank page. Hosts without task views fall back to the sidebar preview.

The controller is Cindy's own: a device chip (status dot, name, device menu for switching, adding and renaming), Home, Rotate, Screenshot and a More menu (Shake, App Switcher, view size up to 200%, full Baguette toolbar, release stuck keys, recover view, confirmed shutdown). The Baguette page inside only renders the live screen (`?handheld=1`, contain-fit with the device's corner radius; foldables keep the 3D view); its workbench chrome is hidden by an injected stylesheet. A lost view, the idle countdown and a shut-down device appear in place of the screen with Recover / Keep using / Start buttons; nothing restarts the simulator or app without an explicit action. Agent recovery uses `press` with `button=release-input`. Unicode paste replaces the simulator clipboard; browser Copy replaces the Mac clipboard. Observe the focused field before input and inspect the result afterwards. Keyboard delivery acknowledgements are not App completion acknowledgements.

Devices live under `~/Library/Application Support/BaguetteCindy/devices`, screenshots under its sibling `screenshots`. No default/Cindy embedded device access or automatic device erasure. Reinstalling the same bundle ID normally preserves App data, but App migrations/logout/server session expiry still govern authentication. Concurrent agents must not interleave operations on one device.

`heal` explicitly restarts SpringBoard and terminates running apps: require user acceptance of that effect. Try releasing stuck keys first. `shutdown` stops the selected simulator but retains its data. `close_viewer` stops streaming, not the simulator.

## User controls

Open **Plugins → iOS Simulator** to view actual private-device states, start or stop a device, open its live view, add a device, or stop all devices. Turning off **Allow simulators to run** first persists the restriction, then shuts down devices and stops the viewer. Failed shutdown remains visible; tools cannot restart a device while the switch is off. Turning it back on never boots a device. Data and login storage are preserved.

Shut down (with confirmation) and view size live in the More menu; the screen fits the window by default. App pinch gestures remain Option-drag or Ctrl-wheel, separate from view size. The idle setting defaults to 15 minutes, with 30 minutes, 1 hour and manual-only options. A device is not stopped while a viewer window is open or another tool or script names it in its own command line (for example `simctl`, `xcodebuild -destination id=…` or the Baguette CLI); device input and tool operations restart the timer, status polling does not. Cindy keeps the plugin worker running while any device or viewer window is up. A device shutdown terminates its apps and connections. All private devices share this inactivity clock; changing the idle setting starts a new period.

The device chip menu provides **Switch**, **Add device** and **Rename**. Adding is prefilled with the newest iPhone and its newest installed iOS runtime (both editable); the new device stays shut down until you switch to it. Plugin settings offer a one-tap **Create your first iPhone** when no device exists. Renaming preserves apps and data. Changing model or runtime creates a separate device, keeping the original. Switching confirms the previous device is shut down before booting the target and shows progress in the same preview. Other running private devices must be stopped first.

The plugin remembers the last app it successfully launched on each device in `runtime-settings.json.apps.json`. When switching from a running device, it can install that app's simulator bundle on the target and launch it; system apps are launched by bundle ID. App data, logins and credentials are never copied. Without an app record, the target opens its home screen. If the source is already off, the recorded app must already exist on the target. Incompatible apps or failed startup are reported with the actual device state; switching does not promise identical content or login state.

Runtime preferences are stored beside the private device set in `runtime-settings.json`, shared by local users of that set. The worker attempts shutdown on normal exit, but forced termination can interrupt it. Use the settings run switch **before** disabling the plugin in Cindy, and verify the displayed device states. A closed/disconnected preview is never proof of shutdown.

## Security and limitations

The Node Worker runs with local user permissions. Executable paths and command shapes are fixed; there is no arbitrary shell tool. The controller listens only on 127.0.0.1; clipboard/control requests require a matching Origin, random capability (kept with the viewer port in `~/Library/Application Support/BaguetteCindy/viewer-session.json`, mode 0600, so an open tab reconnects after the Worker restarts; turning simulators off retires it) and an opened private device. No account tokens are extracted or copied into Cindy storage. Screenshot analysis may send images to the configured model. Actions inside apps can have external side effects and remain subject to the task’s authorization.

The viewer’s optional location map requests reach OpenStreetMap through the fixed-endpoint Node proxy; see VENDOR-REVIEW.md. The farm page uses local font fallbacks without remote font requests. These features do not synchronize simulator accounts. No background dependency installation occurs.

Upstream 0.2.7 adds an app UserDefaults editor (Defaults card) that can read or rewrite any installed app's preferences and relaunch apps with an injected dylib. Those routes ignore the private device set, so the plugin hides the card, returns 404 for them at the viewer proxy and does not bundle `DefaultsLookups.dylib`. Handheld mode is unchanged upstream behavior and stays loopback-only.

Known upstream limitation: stream disconnects can SIGABRT on iOS 27. The supervisor restarts at most five times per minute; the independent controller remains available for manual recovery. This is mitigation, not a native crash fix. Disabling the plugin or quitting Cindy stops the controller too; recovery after Worker exit requires Cindy to start it again. Device data persists across tasks; each task tab remembers its own device.

## Build and verification

Run `sh native/build.sh` on an Apple Silicon Mac with Xcode. This compiles the included Objective-C source and ad-hoc signs the helper. No dependency download. Baguette and HingeControl are rebuilt from v0.2.10 with `vendor-native.patch` (only the version constant); use `sh native/build-baguette.sh <verified-source-archive>` to reproduce the build, then `node native/inventory.mjs --write`. The release build uses whole-program LTO and Swift `-Osize`, strips symbols and ad-hoc signs the host executable to keep tracked binary content below the repository limit. The private device-set and 3D memory fixes this plugin needed were merged upstream (tddworks/baguette#122, #123). `node .tests/baguette/real-simulator-smoke.mjs --foldable` checks a build against real simulators in a throwaway device set.

Run the repository contracts and `.tests/baguette-simulator.test.mjs`. Review VENDOR-REVIEW.md, THIRD-PARTY-LICENSES.txt and the proposal [#119](https://github.com/makecindy/cindy-official-plugins/issues/119). Initial provisioning is an empty targeted audience, not all users. Final package installation in eligible Cindy must be recorded separately from direct Node/native tests.

The optional location panel sends search text and requested map tiles to OpenStreetMap through the Node Worker (fixed nominatim.openstreetmap.org and tile.openstreetmap.org HTTPS endpoints). Browser requests remain same-origin; redirects and arbitrary upstream URLs are rejected. No account credentials are forwarded.

The viewer proxy requires a capability session for HTTP and WebSocket access. The controller exchanges its fragment token for an HttpOnly session cookie. This is not a sandbox against processes with the same macOS user permissions or direct access to the upstream Baguette listener.

## iPhone Duo and Xcode compatibility

Ordinary devices retain the Xcode 26/27 paths. iPhone Duo requires the selected Xcode 27.1 and an installed iOS 27.1 runtime. The upstream viewer includes the Duo 3D model, inner/outer displays, pose buttons and hinge slider; changing the pose changes the simulated device and foreground app layout. The model is read from Xcode, not downloaded by this plugin. The plugin uses the selected Xcode; it does not install, switch or downgrade Xcode automatically. Clipboard writes prefer CoreDevice and fall back to private-set simctl on older or unsupported environments.

Duo preview, closed/open poses, touch and Unicode input were exercised on iOS 27.1 in Cindy 0.1.93 Beta. Xcode 26 integration remains unverified; See VERIFICATION.json for the exact boundary.

## Upstream and license

This plugin is built on [Baguette](https://github.com/tddworks/baguette) by tddworks, licensed under Apache-2.0. Cindy maintains the integration, the Node Worker and the local patches documented in VENDOR-REVIEW.md (`vendor-native.patch`, `vendor-web.patch`). It is not affiliated with or endorsed by tddworks. The bundled HingeControl includes code adapted from Meta's idb (MIT). Full license texts are in THIRD-PARTY-LICENSES.txt and `HingeControl/LICENSE.idb`; the icon is Cindy's own iOS Simulator icon.

If settings cannot be read, device status and shutdown remain available while startup and settings edits stay blocked. Restore the settings file before enabling operation. Device switching may replace an existing target app with the same bundleId when the source app bundle is installed; source app data and login credentials are not copied.
