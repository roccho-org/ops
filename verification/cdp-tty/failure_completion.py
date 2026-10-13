"""A regression using the existing real Chrome/audit/PTY proof components.

An acknowledged input followed by a failed screen read must not be reported as
unsent. The fixture closes only its own proxy after forwarding that input reply.
It neither sends the input itself nor retries it.
"""
import socket
import json
import time
from proof import Audit, AuditHandler, Probe, Sink, browser, eventually, record


class CloseAfterInputReply(AuditHandler):
    def frame(self, data, opcode=1, final=True):
        super().frame(data, opcode, final)
        if self.server.input_seen and opcode == 1:
            self.request.shutdown(socket.SHUT_RDWR)


def prove():
    with browser() as (page, ctl, chrome, _debug, _port):
        ctl.evaluate("document.querySelector('#text').focus()")
        with Audit(page["webSocketDebuggerUrl"]) as audit:
            audit.RequestHandlerClass = CloseAfterInputReply
            sink = Sink(audit.url)
            try:
                sink.wait_frame()
                sink.send("確定済み".encode())
                eventually(lambda: sink.pump() or sink.p.poll() is not None, timeout=5)
            finally:
                code, error = sink.close()
            assert code == 1 and "stage=frame-capture" in error, (code, error)
            assert "completion=acknowledged" in error, error
            assert "completion=not-sent" not in error, error
            assert audit.methods.count("Input.insertText") == 1 and audit.connections == 1
            eventually(lambda: ctl.evaluate("document.querySelector('#text').value") == "確定済み")
            assert "確定済み" not in error and page["webSocketDebuggerUrl"] not in error
            assert chrome.poll() is None
            record("A-post-input-frame-failure-keeps-acknowledged-result", input_count=1,
                   connections=1, terminal_restored=True, browser_alive=True)


def standalone_enter_proof():
    """Default Enter semantics must survive TTY -> CDP, without extra text effects."""
    cases = (
        ("Enter-newline", b"\r", False, "\n", False),
        ("ShiftEnter-newline", b"\x1b[13;2u", False, "\n", True),
        ("CtrlEnter-no-text", b"\x1b[13;5u", False, "", False),
        ("Enter-form-submit", b"\r", True, "", False),
    )
    for name, raw, form, expected, shifted in cases:
        with browser() as (page, ctl, chrome, debug, _):
            # Fixture setup only. Test input below uses only the actual CLI TTY.
            html = ("<form id='form'><input id='text'><button>submit</button></form>"
                    if form else "<textarea id='text' style='width:400px;height:100px;caret-color:transparent'></textarea>")
            ctl.evaluate("document.body.innerHTML=" + json.dumps(html) + ";"
                "window.keyEvents=[];window.inputCount=0;window.submitCount=0;"
                "document.querySelector('#text').addEventListener('keydown',e=>keyEvents.push({key:e.key,shift:e.shiftKey,ctrl:e.ctrlKey}));"
                "document.querySelector('#text').addEventListener('input',()=>inputCount++);"
                "document.querySelector('#text').focus();"
                + ("document.querySelector('#form').addEventListener('submit',e=>{e.preventDefault();submitCount++})" if form else ""))
            with Audit(page['webSocketDebuggerUrl']) as audit:
                sink = Sink(audit.url)
                try:
                    sink.wait_frame()
                    sink.send(raw)
                    sink.wait_frame(sink.frames+1)
                    observed = ctl.evaluate("({value:document.querySelector('#text').value,keys:keyEvents,inputs:inputCount,submits:submitCount})")
                    assert observed['value'] == expected, (name, observed)
                    assert len(observed['keys']) == 1 and observed['keys'][0]['key'] == 'Enter', observed
                    assert observed['keys'][0]['shift'] == shifted, observed
                    assert observed['keys'][0]['ctrl'] == (name == 'CtrlEnter-no-text'), observed
                    assert observed['inputs'] == (1 if expected else 0), observed
                    assert observed['submits'] == (1 if form else 0), observed
                    assert audit.methods.count('Input.dispatchKeyEvent') == 2
                    assert audit.methods.count('Input.insertText') == 0
                    record('A-'+name, key_events=2, separate_insert_text=0,
                        newline=bool(expected), form_submits=observed['submits'])
                finally:
                    code, err = sink.close()
                    assert code == 0, err


class PreEffectRepaint(AuditHandler):
    """Fault the read-only capture, never the input or the final DOM observer."""
    def frame(self, data, opcode=1, final=True):
        if opcode == 1:
            message = json.loads(data)
            result = message.get("result", {})
            if "data" in result:
                self.server.shots += 1
                if self.server.shots == 2 or (self.server.persistent and self.server.shots > 1):
                    result["data"] = self.server.alternate
                    data = json.dumps(message).encode()
        super().frame(data, opcode, final)


def pre_effect_repaint_proof():
    """Only an exact return to the acknowledged picture can permit the first input."""
    for persistent in (False, True):
        with browser() as (page, ctl, chrome, _debug, _port):
            # Sample two genuine fixture images before any product input.
            # The observer never fabricates the expected resulting text.
            ctl.evaluate("document.querySelector('#text').focus(); document.querySelector('#stamp').textContent='alternate'")
            params = {"format": "png", "captureBeyondViewport": False, "fromSurface": False}
            alternate = ctl.call("Page.captureScreenshot", params)["data"]
            ctl.evaluate("document.querySelector('#stamp').textContent='stable'")
            assert alternate != ctl.call("Page.captureScreenshot", params)["data"]
            with Audit(page["webSocketDebuggerUrl"]) as audit:
                audit.RequestHandlerClass = PreEffectRepaint
                audit.alternate, audit.persistent, audit.shots = alternate, persistent, 0
                with Probe(audit.url) as probe:
                    probe.frame()
                    result = probe.command("text original-frame-only")[0]
                    assert result == (2 if persistent else 0), (persistent, result, audit.shots)
                    expected = "" if persistent else "original-frame-only"
                    assert ctl.evaluate("document.querySelector('#text').value") == expected
                    assert audit.methods.count("Input.insertText") == (0 if persistent else 1)
                    assert 3 <= audit.shots <= 18, audit.shots
                    assert audit.connections == 1 and chrome.poll() is None
                    record("A-pre-effect-persistent-pixels-rejected" if persistent else "A-pre-effect-exact-pixels-reconfirmed",
                        captures=audit.shots, input_count=0 if persistent else 1,
                        expected_frame_changed=False, input_retry=0)


def pending_ack_proof():
    """A terminal reply may follow a commit; queue one action, never an effect."""
    for mode in ("matching", "wrong-ack", "focus-change", "missing-ack", "overflow", "resize"):
        with browser() as (page, ctl, chrome, _debug, _port):
            ctl.evaluate("document.querySelector('#text').focus()")
            with Audit(page["webSocketDebuggerUrl"]) as audit:
                sink=Sink(audit.url)
                try:
                    sink.wait_frame()
                    sink.ack=False
                    ctl.evaluate("document.querySelector('#stamp').textContent='repaint'")
                    sink.wait_frame(sink.frames+1)
                    image=sink.image
                    sink.send("保持候補".encode())
                    until=time.monotonic()+.15
                    while time.monotonic()<until: sink.pump()
                    assert audit.methods.count("Input.insertText")==0
                    assert ctl.evaluate("document.querySelector('#text').value")==""
                    if mode=="focus-change":
                        ctl.evaluate("document.querySelector('#other').focus()")
                    if mode=="wrong-ack":
                        sink.send(f"\x1b_Gi={image+1};OK\x1b\\".encode())
                        until=time.monotonic()+.12
                        while time.monotonic()<until: sink.pump()
                        assert audit.methods.count("Input.insertText")==0
                    if mode in ("matching", "wrong-ack", "focus-change"):
                        sink.send(f"\x1b_Gi={image};OK\x1b\\".encode())
                        sink.ack=True
                        sink.wait_frame(sink.frames+1)
                        expected="" if mode=="focus-change" else "保持候補"
                        assert ctl.evaluate("document.querySelector('#text').value")==expected
                        assert ctl.evaluate("document.querySelector('#other').value")==""
                        assert audit.methods.count("Input.insertText")==int(bool(expected))
                    elif mode=="resize":
                        sink.resize(33,101)
                        sink.wait_frame(sink.frames+1)
                        assert sink.image!=image
                        sink.send(f"\x1b_Gi={image};OK\x1b\\".encode())
                        for _ in range(4): sink.pump()
                        assert audit.methods.count("Input.insertText")==0
                        sink.ack=True
                        sink.send(f"\x1b_Gi={sink.image};OK\x1b\\".encode())
                        for _ in range(4): sink.pump()
                        assert audit.methods.count("Input.insertText")==0
                    else:
                        if mode=="overflow": sink.send(b"second")
                        until=time.monotonic()+4
                        while sink.p.poll() is None and time.monotonic()<until: sink.pump()
                        assert sink.p.poll() is not None
                        assert audit.methods.count("Input.insertText")==0
                finally:
                    code,error=sink.close()
                assert code==(1 if mode in ("missing-ack","overflow") else 0), (mode,code,error)
                if mode=="focus-change": assert "reason=stale-frame" in error
                if mode=="missing-ack": assert "stage=image-ack-timeout" in error
                if mode=="overflow": assert "stage=pending-input-limit" in error
                record("A-pending-input-"+mode, input_count=audit.methods.count("Input.insertText"),
                    matching_ack_required=True, input_retry=0, terminal_restored=True)


if __name__ == "__main__":
    pending_ack_proof()
    pre_effect_repaint_proof()
    standalone_enter_proof()
    prove()
