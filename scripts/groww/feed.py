import asyncio
import contextlib
import json
import logging
import math
import os
import signal
import sys
from typing import Any


def emit(message: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(message, allow_nan=False) + "\n")
    sys.__stdout__.flush()

def error_status(error: Exception | None) -> int:
    code = getattr(error, "code", None)
    if code in ("401", "403", "429", "504"):
        return int(code)
    if code == "GA005" or type(error).__name__ == "AuthorizationError":
        return 403
    return 503 if isinstance(error, ModuleNotFoundError) else 502


def normalize_tick(data: dict[str, Any], index: bool) -> dict[str, Any]:
    price = data.get("value" if index else "ltp")
    timestamp = data.get("tsInMillis")
    if isinstance(price, bool) or isinstance(timestamp, bool):
        raise ValueError("Invalid tick")
    if not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
        raise ValueError("Invalid tick price")
    if isinstance(timestamp, str) and timestamp.isdigit():
        timestamp = int(timestamp)
    if not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp <= 0 or timestamp > 8_640_000_000_000_000 or timestamp != int(timestamp):
        raise ValueError("Invalid tick time")
    return {"type": "tick", "price": price, "tradeTime": int(timestamp)}


async def run(config: dict[str, Any]) -> None:
    import certifi
    import nacl.signing
    import nkeys
    import ssl
    from growwapi import GrowwAPI
    from growwapi.groww.constants import FeedConstants
    from growwapi.groww.proto.proto_parser import get_data_dict
    from nats.aio.client import Client

    access_token = config["accessToken"]
    exchange = config["exchange"]
    segment = config["segment"]
    exchange_token = config["exchangeToken"]
    index = config["instrumentType"] == "IDX"
    if exchange not in ("NSE", "BSE") or segment not in ("CASH", "FNO"):
        raise ValueError("Invalid instrument")
    if not isinstance(access_token, str) or not access_token or not isinstance(exchange_token, str) or not exchange_token.isdigit():
        raise ValueError("Invalid subscription")

    # NATS and the SDK use the same NKEY seed; keep credentials in memory.
    seed = os.urandom(32)
    key_pair = nkeys.KeyPair(
        keys=nacl.signing.SigningKey(seed),
        seed=nkeys.encode_seed(seed, nkeys.PREFIX_BYTE_USER),
    )
    credentials = GrowwAPI(access_token).generate_socket_token(key_pair)
    jwt = credentials["token"]
    if not isinstance(jwt, str) or not jwt:
        raise ValueError("Invalid feed credentials")
    topic = (FeedConstants.get_live_index_topic if index else FeedConstants.get_live_price_topic)(
        segment, exchange, exchange_token,
    )
    feed_type = FeedConstants.LIVE_INDEX if index else FeedConstants.LIVE_DATA
    stopped = asyncio.Event()
    closing = False
    ready = False
    pending_tick: dict[str, Any] | None = None
    client = Client()

    async def failed(_error: Exception | None = None) -> None:
        if not closing and not stopped.is_set():
            emit({"type": "error", "code": error_status(_error)})
            stopped.set()

    async def tick(message: Any) -> None:
        nonlocal pending_tick
        try:
            data = get_data_dict(message.data, feed_type)
            if not isinstance(data, dict):
                raise ValueError("Missing tick")
            normalized = normalize_tick(data, index)
            if ready:
                emit(normalized)
            else:
                pending_tick = normalized
        except Exception:
            await failed()

    try:
        await client.connect(
            servers="wss://socket-api.groww.in",
            user_jwt_cb=lambda: jwt.encode("utf-8"),
            nkeys_seed_str=key_pair.seed.decode("utf-8"),
            tls=ssl.create_default_context(cafile=certifi.where()),
            allow_reconnect=False,
            connect_timeout=10,
            ping_interval=15,
            max_outstanding_pings=2,
            error_cb=failed,
            disconnected_cb=failed,
            closed_cb=failed,
        )
        await client.subscribe(topic.get_topic(), cb=tick)
        await client.flush(timeout=10)
        emit({"type": "connected"})
        ready = True
        if pending_tick is not None:
            emit(pending_tick)
        await stopped.wait()
    finally:
        closing = True
        if not client.is_closed:
            await client.close()
        key_pair.wipe()


def main() -> int:
    logging.disable(logging.CRITICAL)
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    try:
        config = json.loads(sys.stdin.readline())
        # SDK output is never forwarded to the browser or application logs.
        with contextlib.redirect_stdout(sys.stderr):
            asyncio.run(run(config))
        return 0
    except Exception as error:
        emit({"type": "error", "code": error_status(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
