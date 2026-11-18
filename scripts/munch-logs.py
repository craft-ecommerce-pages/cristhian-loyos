#!/usr/bin/env python3
# Copia los Workers Logs de Munch (cuenta Cloudflare del cliente) a nas:~/logs/munch/AAAA-MM-DD.log
# Una línea por request/console. Cursor en ~/.cache/munch-logs.cursor. Retención en nas: 7 días.
# cron en worker: */5 * * * * $HOME/.local/bin/con-secretos T=MUNCH_CLOUDFLARE_API_TOKEN -- $HOME/bin/munch-logs.py
# ponytail: 1 consulta de hasta 2000 eventos por ventana; si se llena, parte la ventana en dos (recursivo).
import json, os, subprocess, sys, time, urllib.request
from datetime import datetime, timezone, timedelta
ACC = "ad10d09db0d30a963e1be5a4ed15c1ab"
CUR = os.path.expanduser("~/.cache/munch-logs.cursor")
LAG = 120_000   # ms: Cloudflare tarda en ingerir; no leemos los últimos 2 min
LIMIT = 2000
EC = timezone(timedelta(hours=-5))

def query(frm, to):
    body = json.dumps({"queryId": "munch-pull", "view": "events", "limit": LIMIT,
                       "timeframe": {"from": frm, "to": to}, "parameters": {}}).encode()
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/observability/telemetry/query",
        body, {"Authorization": "Bearer " + os.environ["T"], "Content-Type": "application/json"})
    evs = json.load(urllib.request.urlopen(req, timeout=60))["result"]["events"].get("events", [])
    if len(evs) >= LIMIT and to - frm > 1000:
        mid = (frm + to) // 2
        return query(frm, mid) + query(mid, to)
    return evs

def line(e):
    w, s = e.get("$workers", {}), e.get("source", {})
    ev = w.get("event") or {}
    msg = s.get("message") if isinstance(s, dict) and set(s) <= {"message", "level"} else json.dumps(s, ensure_ascii=False)
    st = (ev.get("response") or {}).get("status", "-")
    ts = datetime.fromtimestamp(e["timestamp"] / 1000, EC).isoformat(timespec="milliseconds")
    lvl = s.get("level", "-") if isinstance(s, dict) else "-"
    return f"{ts} {lvl.upper():5} {w.get('scriptName','-')} {st} {w.get('outcome','-')} {w.get('wallTimeMs','-')}ms {msg}"

now = int(time.time() * 1000) - LAG
try: frm = int(open(CUR).read())
except Exception: frm = now - 3_600_000
frm = max(frm, now - 3 * 86_400_000)  # Workers Logs retiene 3 días
if now <= frm: sys.exit(0)
evs = sorted(query(frm, now), key=lambda e: e["timestamp"])
# rango [frm, now): descarta el borde superior para no duplicar
evs = [e for e in evs if frm <= e["timestamp"] < now]

by_day = {}
for e in evs:
    l = line(e)
    by_day.setdefault(l[:10], []).append(l)
for day, ls in by_day.items():
    subprocess.run(["ssh", "-o", "BatchMode=yes", "nas", f"mkdir -p ~/logs/munch && cat >> ~/logs/munch/{day}.log"],
                   input=("\n".join(ls) + "\n").encode(), check=True)
subprocess.run(["ssh", "-o", "BatchMode=yes", "nas",
                r"mkdir -p ~/logs/munch; find ~/logs/munch -name '*.log' -mtime +0 -exec gzip {} \; ; find ~/logs/munch -name '*.gz' -mtime +7 -delete"], check=True)
open(CUR, "w").write(str(now))
