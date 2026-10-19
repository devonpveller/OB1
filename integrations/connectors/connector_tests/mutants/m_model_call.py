"""MUTANT: calls a model (the LiteLLM alias) to summarise before sending."""
import json
import urllib.request

from connector_kit import Connector, Item


class ModelCall(Connector):
    id = "mutant"
    source = "mutant"

    def collect(self):
        summary = "unsummarised"
        try:
            body = json.dumps({"model": "x", "messages": [{"role": "user", "content": "summarise"}]}).encode()
            with urllib.request.urlopen("http://llama-cpp:8080/v1/chat/completions", data=body, timeout=2) as r:
                summary = r.read().decode()
        except Exception:  # noqa: BLE001
            pass
        yield Item(external_id="m/1", content_type="text/plain", raw=summary)


def factory(config):
    return ModelCall(config)
