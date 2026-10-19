"""I5 e2e finding T-1: transport/http_gateway.py read every reply from a gateway that closes the
connection (HTTP/1.0, or `Connection: close` with a Content-Length) as `network`.

http.client closes the response - and the socket under it - as soon as a body of known length
has been read whole; the read loop then called sock.settimeout() on the closed socket (EBADF ->
`network`), so every judge ask failed and every item waiting for the second opinion expired
`suspicious`. Found by the e2e run against the fake LiteLLM (a BaseHTTPRequestHandler, HTTP/1.0);
reproduced in the service container: `OSError: [Errno 9] Bad file descriptor` at
`sock.settimeout(left)`. The fakes below behave as http.client does."""
import errno
import json
import threading
import unittest
from unittest import mock

from tests import support

from intake import second_opinion
from intake.second_opinion import HttpRequest, TransportError

BODY = json.dumps({"choices": [{"message": {"content": '{"verdict": "clean"}'}, "finish_reason": "stop"}]}).encode()


class _Sock:
    def __init__(self):
        self.closed = False
        self.down = threading.Event()

    def settimeout(self, t):
        if self.closed:
            raise OSError(errno.EBADF, "Bad file descriptor")

    def shutdown(self, how):
        if self.closed:
            raise OSError(errno.EBADF, "Bad file descriptor")
        self.down.set()


class _ClosingResp:
    """read1 hands back the whole known-length body, then closes (as http.client does)."""
    status = 200

    def __init__(self, sock, data, pieces):
        self.sock, self.data, self.pieces = sock, data, pieces
        self._closed = False

    def isclosed(self):
        return self._closed

    def read1(self, n):
        if self._closed:
            return b""
        if self.pieces <= 1 or len(self.data) <= n:
            out, self.data = self.data[:n], self.data[n:]
        else:
            k = max(1, len(self.data) // self.pieces)
            out, self.data = self.data[:k], self.data[k:]
            self.pieces -= 1
        if not self.data:
            self._closed = True
            self.sock.closed = True
        return out


def _conn(data, pieces=1):
    class Conn:
        def __init__(self, host, port, timeout=None):
            self.sock = _Sock()

        def request(self, *a, **k):
            pass

        def getresponse(self):
            return _ClosingResp(self.sock, data, pieces)

        def close(self):
            pass

    return Conn


class ClosingReply(unittest.TestCase):
    def send(self, conn):
        from transport import http_gateway
        req = HttpRequest(url=second_opinion.ENDPOINT, headers=(), body=b"{}", timeout=5.0)
        with mock.patch.object(http_gateway.http.client, "HTTPConnection", conn):
            return http_gateway.send(req)

    def test_a_reply_read_whole_in_one_piece_is_returned(self):
        resp = self.send(_conn(BODY))
        self.assertEqual((resp.status, resp.body), (200, BODY))

    def test_a_reply_in_several_pieces_that_closes_at_the_end_is_returned(self):
        resp = self.send(_conn(BODY, pieces=4))
        self.assertEqual(resp.body, BODY)

    def test_the_judge_reads_a_verdict_through_such_a_gateway(self):
        from transport import http_gateway
        j = second_opinion.Judge(http_gateway.send, env={second_opinion.KEY_ENV: "sk-" + "a" * 30})
        ji = second_opinion.JudgeInput(("some text",), "web/test", True)
        with mock.patch.object(http_gateway.http.client, "HTTPConnection", _conn(BODY)):
            op = j.ask(ji)
        self.assertEqual((op.outcome, op.verdict), ("verdict", "clean"))

    def test_a_socket_that_dies_before_the_body_is_complete_is_still_network(self):
        from transport import http_gateway

        class Broken(_ClosingResp):
            def read1(self, n):
                self.sock.closed = True
                return b"{"

        class Conn(_conn(BODY)):
            def getresponse(self):
                return Broken(self.sock, BODY, 1)

        req = HttpRequest(url=second_opinion.ENDPOINT, headers=(), body=b"{}", timeout=5.0)
        with mock.patch.object(http_gateway.http.client, "HTTPConnection", Conn):
            with self.assertRaises(TransportError) as cm:
                http_gateway.send(req)
        self.assertEqual(cm.exception.kind, "network")


assert support
if __name__ == "__main__":
    unittest.main()
