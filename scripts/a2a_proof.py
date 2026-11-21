"""End-to-end proof of the 180Climate Fieldwork A2A endpoint, using the official
A2A Python SDK (a2a-sdk) as an outside agent would.

    python a2a_proof.py <test-deployment-url>

It creates a test draft: run it only against a test deployment you are
authorised to use, with a synthetic client key issued for that deployment.

The client key comes from the FIELDWORK_CLIENT_KEY environment variable, or
from a hidden prompt. It is never printed or written to the log.

Steps: 1) discover the Agent Card at /.well-known/agent-card.json; 2) confirm a
call without a client key is refused; 3) draft one clearly marked test job
(it stays an invisible draft unless a person publishes it); 4) read it back
with GetTask; 5) list tasks. A JSON log of the run is written next to this file.
"""
import asyncio
import datetime as dt
import getpass
import json
import os
import sys
import uuid
from importlib.metadata import version
from pathlib import Path

import httpx
from google.protobuf import json_format
from a2a.client import A2ACardResolver, AuthInterceptor, ClientConfig, ClientFactory, CredentialService
from a2a.types import GetTaskRequest, ListTasksRequest, Message, Part, Role, SendMessageRequest


class ClientKey(CredentialService):
    def __init__(self, key: str):
        self._key = key

    async def get_credentials(self, security_scheme_name, context):
        return self._key if security_scheme_name == "fieldworkClientKey" else None


def test_job() -> dict:
    sgt = dt.timezone(dt.timedelta(hours=8))
    day = dt.datetime.now(sgt).date() + dt.timedelta(days=30)
    return {
        "title": "A2A proof test - do not publish",
        "outcome": "Test draft created by the A2A proof run. It is not a real job.",
        "region": "Riau, Sumatra",
        "windowStart": day.isoformat(),
        "windowEnd": (day + dt.timedelta(days=1)).isoformat(),
        "budgetMin": 1,
        "budgetMax": 2,
        "currency": "USD",
        "bidDeadline": f"{(day - dt.timedelta(days=3)).isoformat()}T18:00:00+08:00",
        "site": "Proof site",
        "items": ["T1"],
        "checkDeadline": f"{(day + dt.timedelta(days=3)).isoformat()}T18:00:00+08:00",
    }


async def main(base: str) -> int:
    log = {"started": dt.datetime.now(dt.timezone.utc).isoformat(), "endpoint_base": base, "a2a_sdk": version("a2a-sdk"), "steps": []}

    def step(label: str, ok: bool, **detail):
        log["steps"].append({"step": label, "ok": ok, **detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f"  {json.dumps(detail)}" if detail else ""))

    code = os.environ.get("FIELDWORK_CLIENT_KEY") or getpass.getpass("Fieldwork A2A client key (hidden): ")
    async with httpx.AsyncClient(timeout=30) as http:
        card = await A2ACardResolver(http, base).get_agent_card()
        iface = card.supported_interfaces[0]
        step("1 discover Agent Card", bool(card.name), name=card.name, url=iface.url, binding=iface.protocol_binding, version=iface.protocol_version)

        cfg = ClientConfig(streaming=False, httpx_client=http)
        anon = ClientFactory(cfg).create(card)
        try:
            await anon.list_tasks(ListTasksRequest(page_size=1))
            step("2 refuse a call without a client key", False, note="the call was accepted")
        except Exception as e:  # the SDK raises on HTTP 401
            step("2 refuse a call without a client key", "401" in str(e) or "Unauthenticated" in str(e), error=type(e).__name__)

        client = ClientFactory(cfg).create(card, interceptors=[AuthInterceptor(ClientKey(code))])
        msg = Message(message_id=f"proof-{uuid.uuid4()}", context_id=f"proof-{uuid.uuid4()}", role=Role.ROLE_USER,
                      parts=[json_format.ParseDict({"data": test_job(), "mediaType": "application/json"}, Part())])
        task = None
        async for event in client.send_message(SendMessageRequest(message=msg)):
            if event.HasField("task"):
                task = event.task
            elif event.HasField("message"):
                step("3 SendMessage drafts a job", False, reply=event.message.parts[0].text)
        if task is None:
            return finish(log, 1)
        step("3 SendMessage drafts a job", task.status.state != 0, task_id=task.id, state=json_format.MessageToDict(task.status)["state"])

        got = await client.get_task(GetTaskRequest(id=task.id))
        step("4 GetTask reads it back", got.id == task.id, state=json_format.MessageToDict(got.status)["state"],
             says=got.status.message.parts[0].text[:160])

        listed = await client.list_tasks(ListTasksRequest(page_size=5))
        step("5 ListTasks includes it", any(t.id == task.id for t in listed.tasks), total=listed.total_size)
    return finish(log, 0 if all(s["ok"] for s in log["steps"]) else 1)


def finish(log: dict, rc: int) -> int:
    log["finished"] = dt.datetime.now(dt.timezone.utc).isoformat()
    log["result"] = "PASS" if rc == 0 else "FAIL"
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H%M")
    out = Path(__file__).with_name(f"{stamp} A2A proof log.json")
    out.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"\nRESULT: {log['result']}   (log: {out})")
    return rc


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1].rstrip("/"))))
