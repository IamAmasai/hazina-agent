#!/usr/bin/env python3
"""Hazi's console — renders a run directory, never imports the agent
(workshop console pattern). Reads record.json + pack.md and shows the month
the way the merchant sees it: what came in, what matched, what Hazi asked,
what it computed, and the record behind every figure. Phone-first, no JS.

  python3 ui/console.py --run runs/2026-10 --export console.html
  python3 ui/console.py --run runs/2026-10 --port 8765
"""
import argparse
import html
import json
import os

CSS = """
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F5F8FC;
color:#0D1B2A;margin:0;padding:16px;max-width:720px;margin-inline:auto}
h1{font-size:22px;margin:4px 0} h2{font-size:16px;margin:22px 0 8px}
.sub{color:#5A6B7E;font-size:13px}
.card{background:#fff;border:1px solid #E2EAF3;border-radius:12px;padding:14px;margin:10px 0}
.big{font-size:28px;font-weight:700}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;
background:#EAF3FF;color:#2563EB;margin-left:6px}
.chip.warn{background:#FFF3D6;color:#8A6D00}.chip.bad{background:#FFE8E8;color:#A33}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 4px;border-bottom:1px solid #EEF2F7;text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums}
pre{white-space:pre-wrap;font-size:12px;background:#0D1B2A;color:#DCE9F7;
border-radius:12px;padding:14px;overflow-x:auto}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#5A6B7E}
"""


def esc(x):
    return html.escape(str(x if x is not None else ""))


def render(run_dir):
    with open(os.path.join(run_dir, "record.json")) as fh:
        rec = json.load(fh)
    pack_path = os.path.join(run_dir, "pack.md")
    pack = ""
    if os.path.exists(pack_path):
        with open(pack_path) as fh:
            pack = fh.read()
    txns = {t["id"]: t for t in rec["transactions"]}
    tot_line = next((d for d in rec["decisions"] if d["kind"] == "tot_computation"), {})
    parts = [f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hazi — {esc(rec['business'])} {esc(rec['period'])}</title>
<style>{CSS}</style></head><body>
<h1>{esc(rec['business'])} — {esc(rec['period'])}</h1>
<div class="sub">Prepared by Hazi · status: {esc(rec['status'])} · 
profile: {esc((rec.get('profile') or {}).get('income_tax_profile'))}</div>
<div class="card"><div class="sub">Turnover Tax payable</div>
<div class="big">{esc(tot_line.get('detail', '—'))}</div>
<div class="mono">record hash: {esc((tot_line.get('content_sha256') or '')[:16])}…</div></div>"""]

    parts.append("<h2>Documents</h2><div class='card'><table>")
    for sha, doc in rec["documents"].items():
        parts.append(f"<tr><td>{esc(doc['kind'])}</td>"
                     f"<td class='mono'>{esc(sha[:16])}…</td></tr>")
    parts.append("</table></div>")

    parts.append("<h2>Matches — receipts to statement lines</h2><div class='card'><table>")
    for m in rec["matches"]:
        line = txns.get(m["transaction_id"]) or {}
        parts.append(f"<tr><td>{esc(line.get('details'))}</td>"
                     f"<td class='num'>KSh {line.get('amount_kes', 0):,.0f}</td>"
                     f"<td class='mono'>{esc(m['basis'])}</td></tr>")
    parts.append("</table></div>")

    parts.append("<h2>Hazi asked</h2>")
    if rec["questions"]:
        for q in rec["questions"]:
            chip = {"answered": "", "open": "chip warn", "escalated": "chip bad"}[q["status"]]
            parts.append(f"<div class='card'>{esc(q['question'])}"
                         f"<span class='chip {chip}'>{esc(q['status'])}</span>"
                         + (f"<div class='sub'>Merchant: {esc(q['answer'])}</div>"
                            if q.get("answer") else "") + "</div>")
    else:
        parts.append("<div class='card'>No questions — every line was evidenced.</div>")

    parts.append("<h2>Decisions</h2><div class='card'><table>")
    for d in rec["decisions"]:
        parts.append(f"<tr><td>{esc(d['kind'])}</td><td>{esc(d['detail'])}</td>"
                     f"<td class='mono'>{(d.get('content_sha256') or '')[:16]}…</td></tr>")
    parts.append("</table></div>")
    parts.append(f"<h2>Filing pack</h2><pre>{esc(pack)}</pre></body></html>")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--export")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    page = render(args.run)
    if args.export:
        with open(args.export, "w") as fh:
            fh.write(page)
        print(f"console snapshot written to {args.export}")
        return
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = render(args.run).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
