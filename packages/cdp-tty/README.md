# cdp-tty

A small C core, one TTY adapter and a thin CLI. The caller supplies one
already-running page WebSocket on numeric loopback. Chrome owns its process,
tabs, viewport and persistent profile/auth state; this viewer owns only its
connection, current image, coordinate mapping and terminal modes.

Source decision: roccho-dev/adrs#423. Original implementation: roccho-org/ops#426.
Standalone Viewer scope A: roccho-org/ops#534 and `verification/cdp-tty/split.md`.
This is not a declaration of complete #423, B (Meltype) or C (combined) acceptance.

## Use and ownership

`cdp-tty [--observe] ws://127.0.0.1:PORT/devtools/page/EXPLICIT_TARGET_ID`

Use a real Linux TTY whose terminal reports its cell pixel size and acknowledges
Kitty image transmission. No assumed cell size, remote pathname, shared memory
or mux. Ctrl-Q exits. A lost connection exits; restart explicitly to attach
afresh. No automatic reconnect, target switching or input replay is performed.

The core is also callable through `cdp.h` and `libcdp-tty.a`; `tests/probe.c` is a
second real caller. This is not a separately versioned stable binary ABI: rebuild
consumers against the matching header/library. The core installs no signal
handler, takes no TTY, exits no process and saves nothing to HOME. The CLI owns
cancellation; `tty.c` owns terminal restoration.

Runtime dependencies are WebSocket-enabled libcurl and json-c. Chrome, Python,
Kitty, Xvfb, XTEST tools and fonts are test inputs, not runtime dependencies.
There is no Chrome launcher, shell/SSH wrapper, Node, Qt, DB, daemon or automation
framework in the viewer. Test code alone owns disposable browsers, pages and an
auditing proxy. No Anoa/casty/cmux code is copied; licensing policy is unchanged.

## Browser boundary

Only these nine methods can appear on the wire; caller-supplied JavaScript or
arbitrary method/JSON forwarding is not exposed:

| Method | Purpose |
|---|---|
| `Page.getLayoutMetrics` | CSS viewport, scroll and supported zoom geometry |
| `Page.getFrameTree` | Main-frame loader identity across navigation |
| `Page.captureScreenshot` | Existing-view PNG, without clip or emulation |
| `Input.dispatchMouseEvent` | Click, wheel or a finite endpoint drag |
| `Input.dispatchKeyEvent` | Supported key-down/up pairs and modifiers |
| `Input.insertText` | Committed UTF-8 text |
| `Runtime.evaluate` | Two fixed side-effect-checked reads: viewport/DPR and activeElement identity handle |
| `DOM.describeNode` | Compare stable backend node IDs; reject invisible focus change |
| `Runtime.releaseObject` | Release the temporary activeElement object reference |

Capturing with a clip previously reset an independent controller's DPR. The
current capture uses `fromSurface:false`, no clip and no viewport mutation.
The exact fixed geometry expression supplies scrollbar-inclusive dimensions;
`throwOnSideEffect` rejects a page getter that would write state. Tests assert
both the method allowlist and the exact expression/flags. No form values, page
HTML, credentials or variable expressions are read by the viewer.

Before input, compare fresh pixels, geometry, loader and backend focus identity
with the acknowledged presentation. A focus switch between two input elements
with pixel-identical screens is rejected. Authored Shadow DOM and nested frame
focus are opaque to this bounded adapter: TEXT/KEY are refused there rather
than assuming a global caret. Native input user-agent shadow roots remain
allowed. Focus revalidation is still subject to an unavoidable check/use race;
there is no browser-side atomic focus lock. A changed input target must be
re-ACKed with a fresh screen before entering more text. Stale input is rejected, not replayed. This is not an atomic lock
against another client: animation, caret changes or concurrent navigation can
reject otherwise useful input. Agent/human handoff remains outside this package.

A change during read-only capture retries only that read, within a three-second
stability deadline. It does not wait for an acknowledgement of a frame that was
never sent. Terminal resize fits/centres locally without changing Chrome's
viewport; old image acknowledgements cannot arm a new presentation.

## Input and failure contracts

Supported: observe-only; left/middle/right click; wheel; committed UTF-8 and
bracketed paste; Enter, Tab, Backspace, Delete, Escape, arrows, Home/End, PageUp,
PageDown, Insert, Ctrl-A; finite ASCII Ctrl/Alt and CSI-u keys; modified arrows
and Shift-Tab. Unsupported control reports are never reinterpreted as text.
A terminal read boundary is not an IME commit boundary: split printable text is
coalesced for a bounded 40 ms quiet interval or a following control delimiter.
This is not an unbounded typing queue. Input received for an unacknowledged or
stale presentation can be discarded; users must inspect the refreshed view.

Mouse positions use terminal cell centres, not pixel-precise pointer reports.
A drag retains only start/end and sends press, eight interpolated moves, release
when the physical release arrives. No live mid-drag preview or arbitrary
long-lived pressed-button session is promised. A lost input response terminates
the connection; no automatic retry or compensating release is sent.

Failure diagnostics report only a fixed stage/method and conservative completion
state: stale-frame, unstable-frame, image-ack-timeout, malformed terminal token,
or input-dispatch/unknown. They do not include target URLs, page content or typed
text. Normal exit, SIGTERM and SIGHUP restore saved TTY state. SIGKILL cannot run
cleanup and cannot promise terminal restoration. The browser is never terminated
or its profile changed by viewer shutdown.

## Proof and downstream reuse

`make check` builds the actual C library and CLI and requires the existing
`verification/cdp-tty/proof.py` with its real test dependencies. No alternate
mock-only path can pass the package proof. `nix-build packages/cdp-tty/proof.nix
--no-out-link` uses the repository's pinned nixpkgs without unrelated private
flake inputs. Outputs: `out` (CLI), `dev` (library/header), `proof` (evidence).
The same proof runs in `.github/workflows/cdp-tty-proof.yml` for changes to its
package, tests, lock or workflow, on PRs and pushes to proposals. It no longer
depends on PR #534 existing. The job is moved, not duplicated; unrelated
previously deferred #460 work remains unchanged.

The independent CDP observer prepares synthetic test pages and reads actual DOM
changes. An audit proxy verifies the finite wire surface. The real PTY protocol
sink checks PNG CRC/decompression, image IDs, split acknowledgements/UTF-8,
mouse/key/text, resize and cleanup, but is not a terminal renderer. Separate
mandatory Kitty/Xvfb/XTEST/scrot checks exercise actual terminal-rendered pixels,
Japanese input, wheel, resize, normal exit and explicit reattachment to the same
still-running Chrome target. No Meltype or bcon is required by A.

Fault tests retain malformed/oversized WebSocket, JSON, PNG, paste and numeric
control cases, stale navigation/pixels, pixel-identical focus changes,
image-ACK generation, read-only capture
instability and unknown input completion with exactly one send. A loopback HTTP
login fixture verifies authenticated requests, cookies, targets and viewport
survive normal exit, SIGTERM, SIGHUP and SIGKILL, and missing cookies are rejected.
That is synthetic-service evidence, not a user's third-party login or SSH outage.
Missing dependencies, browser policy rejection and assertions fail rather than
silently skipping these gates.

Evidence includes `raws.jsonl`, `disruptives.jsonl`, source hashes, dependency
versions and one synthetic-page `real-terminal.png`. No user page image, target
URL, credential or typed secret is recorded. C consumes matching code/header,
package and proof references; it must not copy runtime source or substitute an
older green run for the candidate being integrated.

Remaining outside this bounded slice: IME preedit, every extended keyboard
encoding, universal GUI caret/Undo, pinch/browser zoom combinations, live drag
preview, Windows/SSH/selected-OCI and physical keyboard deployment, real-service
auth survival and sustained CPU/bandwidth evaluation. The real Linux renderer
proof does not attest those paths. A's independent same-revision review remains
a separate merge gate; self-checks and test counts cannot replace it. Do not close
#423 or remove existing recovery paths based on this package alone.
