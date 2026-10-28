"""Meta Model API client (OpenAI-compatible).

Auth, in order: MODEL_API_KEY from the environment (deployment shape), else
the registered vault connector surrogate (local development — the key never
touches a file). The model is always the standard tier for business data;
never the -contributor variants.
"""
import base64
import json
import os
import urllib.request

BASE = "https://api.meta.ai/v1"
DEFAULT_MODEL = "muse-spark-1.3"


def _request(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    key = os.environ.get("MODEL_API_KEY")
    if key:
        req.add_header("Authorization", "Bearer " + key)
    else:
        import sys
        sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
        from dynamic_credentials import add_surrogate_to_request
        add_surrogate_to_request(req, "custom.meta-model-api", allowed_hosts=["api.meta.ai"])
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def chat(messages, model=DEFAULT_MODEL, max_tokens=3000):
    """Returns (content_text, usage_dict). max_tokens is sized generously:
    Spark spends tokens on reasoning before it writes."""
    body = _request({"model": model, "messages": messages, "max_tokens": max_tokens})
    choice = (body.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content") or ""
    return content, body.get("usage") or {}


def vision_extract(image_path, prompt, model=DEFAULT_MODEL, max_tokens=3000):
    with open(image_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    ext = os.path.splitext(image_path)[1].lower().lstrip(".") or "png"
    messages = [{"role": "user", "content": [
        {"type": "text", "text": prompt},
        {"type": "image_url",
         "image_url": {"url": f"data:image/{ext};base64,{b64}"}},
    ]}]
    return chat(messages, model=model, max_tokens=max_tokens)
