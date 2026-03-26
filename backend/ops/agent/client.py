"""UDS client for communicating with the Local Control Agent."""

from __future__ import annotations

import asyncio
import json
import logging

from backend.ops.agent.protocol import AgentRequest, AgentResponse

logger = logging.getLogger(__name__)

DEFAULT_SOCKET = "/var/run/bifrost-agent.sock"
_CONNECT_TIMEOUT = 5
_READ_TIMEOUT = 35


class AgentClient:
    """Send structured commands to the Local Control Agent over UDS."""

    def __init__(self, socket_path: str = DEFAULT_SOCKET) -> None:
        self._socket_path = socket_path

    async def send(self, req: AgentRequest) -> AgentResponse:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self._socket_path),
                timeout=_CONNECT_TIMEOUT,
            )
        except (ConnectionRefusedError, FileNotFoundError, asyncio.TimeoutError) as e:
            return AgentResponse(
                request_id=req.request_id,
                ok=False,
                error=f"Agent unavailable ({self._socket_path}): {e}",
            )

        try:
            payload = json.dumps(req.to_dict()).encode()
            writer.write(payload)
            await writer.drain()
            writer.write_eof()

            data = await asyncio.wait_for(reader.read(65536), timeout=_READ_TIMEOUT)
            if not data:
                return AgentResponse(
                    request_id=req.request_id,
                    ok=False,
                    error="Empty response from agent",
                )
            resp_dict = json.loads(data.decode())
            return AgentResponse.from_dict(resp_dict)
        except asyncio.TimeoutError:
            return AgentResponse(
                request_id=req.request_id,
                ok=False,
                error=f"Agent response timed out after {_READ_TIMEOUT}s",
            )
        except Exception as e:
            return AgentResponse(
                request_id=req.request_id,
                ok=False,
                error=f"Agent communication error: {e}",
            )
        finally:
            writer.close()

    async def systemctl(self, action: str, unit: str, timeout: int = 30) -> AgentResponse:
        req = AgentRequest(action=action, unit=unit, timeout=timeout)
        return await self.send(req)

    async def list_instances(self, pattern: str = "bifrost-celery-worker@*") -> AgentResponse:
        req = AgentRequest(action="list-units", unit=pattern)
        return await self.send(req)

    async def is_active(self, unit: str) -> AgentResponse:
        req = AgentRequest(action="is-active", unit=unit)
        return await self.send(req)

    async def ping(self) -> bool:
        try:
            await self.is_active("bifrost-celery-worker.service")
            return True
        except Exception:  # noqa: BLE001
            return False
