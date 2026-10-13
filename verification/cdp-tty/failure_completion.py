"""A regression using the existing real Chrome/audit/PTY proof components.

An acknowledged input followed by a failed screen read must not be reported as
unsent. The fixture closes only its own proxy after forwarding that input reply.
It neither sends the input itself nor retries it.
"""
import socket
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


if __name__ == "__main__":
    prove()
