"""Agent debug NDJSON logger (session d22d24). Do not log secrets."""
import json
import threading
import time

_DEBUG_PATH = "/Users/vision-mac-trader/Desktop/stocks/bifrost-trader-engine/.cursor/debug-d22d24.log"


def agent_log(message: str, data: dict, hypothesis_id: str) -> None:
    try:
        line = json.dumps(
            {
                "sessionId": "d22d24",
                "timestamp": int(time.time() * 1000),
                "location": "servers.debug_ndjson",
                "message": message,
                "data": {**data, "thread_id": threading.get_ident()},
                "hypothesisId": hypothesis_id,
            },
            default=str,
        )
        with open(_DEBUG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
