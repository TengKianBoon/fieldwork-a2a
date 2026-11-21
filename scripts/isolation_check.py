"""Release check for Fieldwork A2A: two clients, each with its own
key, must each see their own task and nothing of the other's. Refusals must be
exactly A2A's TaskNotFoundError (code -32001, reason TASK_NOT_FOUND), and an
unknown key must get HTTP 401.

    python isolation_check.py <test-deployment-url>

It creates two test drafts: run it only against a test deployment you are
authorised to use.

The two client keys come from FIELDWORK_CLIENT_KEY_A and FIELDWORK_CLIENT_KEY_B,
or from hidden prompts; use two synthetic test clients. Keys are never printed
or logged. Each client drafts one clearly marked test job (an invisible draft
unless a person publishes it). A JSON log is written next to this file.
"""
import asyncio, datetime as dt, getpass, json, os, sys, uuid
from importlib.metadata import version
from pathlib import Path

import httpx
from google.protobuf import json_format
from a2a.client import A2ACardResolver, AuthInterceptor, ClientConfig, ClientFactory, CredentialService
from a2a.types import GetTaskRequest, ListTasksRequest, Message, Part, Role, SendMessageRequest


class Key(CredentialService):
    def __init__(self, key):
        self._key = key

    async def get_credentials(self, scheme, context):
        return self._key if scheme == "fieldworkClientKey" else None


def job(label):
    day = dt.date.today() + dt.timedelta(days=30)
    return {"title": f"A2A isolation test {label} - do not publish", "outcome": "Test draft from the isolation check. Not a real job.",
            "region": "Riau, Sumatra", "windowStart": day.isoformat(), "windowEnd": (day + dt.timedelta(days=1)).isoformat(),
            "budgetMin": 1, "budgetMax": 2, "currency": "USD", "bidDeadline": f"{(day - dt.timedelta(days=3)).isoformat()}T18:00:00+08:00",
            "site": "Proof site", "items": ["T1"], "checkDeadline": f"{(day + dt.timedelta(days=3)).isoformat()}T18:00:00+08:00"}


async def rpc(http, base, key, method, params):
    """A raw A2A JSON-RPC call, so the exact error code, reason and HTTP status can be checked."""
    r = await http.post(f"{base}/a2a", json={"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": method, "params": params},
                        headers={"A2A-Version": "1.0", **({"X-Fieldwork-Key": key} if key else {})})
    try:
        body = r.json()
    except ValueError:
        body = {}
    return r.status_code, body


def not_found(status, body):
    """Exactly A2A's TaskNotFoundError: HTTP 200, code -32001, ErrorInfo reason TASK_NOT_FOUND."""
    err = body.get("error") or {}
    info = (err.get("data") or [{}])[0]
    return status == 200 and err.get("code") == -32001 and info.get("reason") == "TASK_NOT_FOUND"


async def main(base):
    ka = os.environ.get("FIELDWORK_CLIENT_KEY_A") or getpass.getpass("Client key A (hidden): ")
    kb = os.environ.get("FIELDWORK_CLIENT_KEY_B") or getpass.getpass("Client key B (hidden): ")
    log = {"started": dt.datetime.now(dt.timezone.utc).isoformat(), "endpoint_base": base, "a2a_sdk": version("a2a-sdk"), "checks": []}

    def check(name, ok):
        log["checks"].append({"check": name, "ok": ok})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")

    async with httpx.AsyncClient(timeout=30) as http:
        card = await A2ACardResolver(http, base).get_agent_card()
        cfg = ClientConfig(streaming=False, httpx_client=http)
        a = ClientFactory(cfg).create(card, interceptors=[AuthInterceptor(Key(ka))])
        b = ClientFactory(cfg).create(card, interceptors=[AuthInterceptor(Key(kb))])
        tasks = {}
        for name, cl in (("A", a), ("B", b)):
            m = Message(message_id=f"iso-{uuid.uuid4()}", role=Role.ROLE_USER, parts=[json_format.ParseDict({"data": job(name)}, Part())])
            tasks[name] = [e async for e in cl.send_message(SendMessageRequest(message=m))][0].task
            check(f"client {name} drafts its own task", bool(tasks[name].id))
        keys = {"A": ka, "B": kb}
        for me, other, cl in (("A", "B", a), ("B", "A", b)):
            own = await cl.get_task(GetTaskRequest(id=tasks[me].id))
            check(f"client {me} reads its own task", own.id == tasks[me].id)
            listed = await cl.list_tasks(ListTasksRequest(page_size=100, include_artifacts=True))
            dump = json.dumps(json_format.MessageToDict(listed))
            check(f"client {me}'s ListTasks holds its own task", tasks[me].id in dump)
            check(f"client {me}'s ListTasks holds nothing of {other}", tasks[other].id not in dump and f"isolation test {other}" not in dump)
            k, oid = keys[me], tasks[other].id
            check(f"client {me} cannot read {other}'s task (-32001 TASK_NOT_FOUND)", not_found(*await rpc(http, base, k, "GetTask", {"id": oid})))
            check(f"client {me} cannot cancel {other}'s task (-32001 TASK_NOT_FOUND)", not_found(*await rpc(http, base, k, "CancelTask", {"id": oid})))
            follow = {"message": {"messageId": f"iso-{uuid.uuid4()}", "taskId": oid, "role": "ROLE_USER", "parts": [{"text": "status?"}]}}
            check(f"client {me} cannot message {other}'s task (-32001 TASK_NOT_FOUND)", not_found(*await rpc(http, base, k, "SendMessage", follow)))
        status, body = await rpc(http, base, "fwk_not-a-client-key", "GetTask", {"id": tasks["A"].id})
        check("an unknown key is refused (HTTP 401, -32000 UNAUTHENTICATED)", status == 401 and (body.get("error") or {}).get("code") == -32000
              and ((body.get("error") or {}).get("data") or [{}])[0].get("reason") == "UNAUTHENTICATED")
        status, body = await rpc(http, base, None, "GetTask", {"id": tasks["A"].id})
        check("no key is refused (HTTP 401)", status == 401)
    log["finished"] = dt.datetime.now(dt.timezone.utc).isoformat()
    log["result"] = "PASS" if all(c["ok"] for c in log["checks"]) else "FAIL"
    out = Path(__file__).with_name(f"{dt.datetime.now().strftime('%Y-%m-%d %H%M')} A2A isolation log.json")
    out.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"\nRESULT: {log['result']}   (log: {out})")
    return 0 if log["result"] == "PASS" else 1


async def _first(agen):
    async for e in agen:
        return e


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1].rstrip("/"))))
