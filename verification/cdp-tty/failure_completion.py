"""A regression using the existing real Chrome/audit/PTY proof components.

An acknowledged input followed by a failed screen read must not be reported as
unsent. The fixture closes only its own proxy after forwarding that input reply.
It neither sends the input itself nor retries it.
"""
import socket
import json
from proof import Audit, AuditHandler, Sink, browser, eventually, record


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


if __name__ == "__main__":
    standalone_enter_proof()
    prove()
