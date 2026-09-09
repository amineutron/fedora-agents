#!/usr/bin/env python3
"""Demonstration d'un serveur MCP en stdio : liste des outils puis appels en lecture seule.

Usage : mcp_demo.py "<commande du serveur>" [outil[:json_args] ...]
Les adresses IP privees et adresses MAC des sorties sont masquees (valeurs d'exemple).
"""
import asyncio
import json
import os
import re
import shlex
import sys
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

IP_RE = re.compile(r"\b192\.168\.\d+\.(\d+)\b")
MAC_RE = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")


def mask(text: str) -> str:
    return MAC_RE.sub("AA:BB:CC:DD:EE:FF", IP_RE.sub(r"192.0.2.\1", text))


def say(text: str, delay: float = 0.02) -> None:
    for ch in text:
        sys.stdout.write(ch)
        sys.stdout.flush()
        time.sleep(delay)
    sys.stdout.write("\n")
    sys.stdout.flush()


async def main() -> None:
    cmd = shlex.split(sys.argv[1])
    calls = sys.argv[2:]
    say(f"$ {os.environ.get('DEMO_SHOW') or sys.argv[1]}")
    params = StdioServerParameters(command=cmd[0], args=cmd[1:], env=dict(os.environ))
    async with stdio_client(params, errlog=open(os.devnull, "w")) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            say(f"\n> tools/list : {len(tools.tools)} outils")
            names = [t.name for t in tools.tools]
            for i in range(0, len(names), 6):
                say("  " + "  ".join(names[i:i + 6]), 0.005)
            for call in calls:
                name, _, raw = call.partition(":")
                args = json.loads(raw) if raw else {}
                say(f"\n> tools/call {name} {json.dumps(args, ensure_ascii=False) if args else ''}".rstrip())
                time.sleep(0.6)
                try:
                    res = await asyncio.wait_for(session.call_tool(name, args), timeout=40)
                    out = "\n".join(getattr(c, "text", "") for c in res.content)
                except Exception as exc:  # on montre l'erreur telle quelle : c'est une demo honnete
                    out = f"erreur : {exc}"
                for line in mask(out).splitlines()[:18]:
                    print("  " + line[:110])
                    sys.stdout.flush()
                time.sleep(1.0)
    say("\n# fin de la démonstration")
    time.sleep(1.5)


if __name__ == "__main__":
    asyncio.run(main())
