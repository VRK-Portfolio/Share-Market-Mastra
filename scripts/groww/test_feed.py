import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import feed
from growwapi import GrowwAPI
from growwapi.groww.constants import FeedConstants
from growwapi.groww.proto.proto_parser import get_data_dict
from growwapi.groww.proto.stocks_socket_response_pb2 import StocksSocketResponseProtoDto


class FeedTests(unittest.TestCase):
    def test_auth_errors_keep_status_without_exposing_provider_messages(self):
        from growwapi.groww.exceptions import GrowwAPIAuthenticationException, GrowwAPIAuthorisationException
        self.assertEqual(feed.error_status(GrowwAPIAuthenticationException()), 401)
        self.assertEqual(feed.error_status(GrowwAPIAuthorisationException()), 403)
        self.assertEqual(feed.error_status(ModuleNotFoundError("private-path")), 503)
        self.assertEqual(feed.error_status(ValueError("private-provider-response")), 502)

    def test_official_protobuf_prices_and_indices(self):
        for index in (False, True):
            packet = StocksSocketResponseProtoDto()
            price = packet.stocksLiveIndices if index else packet.stockLivePrice
            price.tsInMillis = 1_800_000_000_000
            if index:
                price.value = 23456.5
            else:
                price.ltp = 23456.5
            decoded = get_data_dict(packet.SerializeToString(), FeedConstants.LIVE_INDEX if index else FeedConstants.LIVE_DATA)
            self.assertEqual(feed.normalize_tick(decoded, index), {
                "type": "tick", "price": 23456.5, "tradeTime": 1_800_000_000_000,
            })

    def test_invalid_ticks_are_not_fabricated(self):
        for price in (None, True, float("nan"), float("inf"), -1, 0, "123"):
            with self.assertRaises(ValueError):
                feed.normalize_tick({"ltp": price, "tsInMillis": 1_800_000_000_000}, False)
        for timestamp in (None, True, float("inf"), float("nan"), 123.5, -1, 0, "invalid"):
            with self.assertRaises(ValueError):
                feed.normalize_tick({"ltp": 123, "tsInMillis": timestamp}, False)
        self.assertEqual(feed.normalize_tick({"ltp": 123, "tsInMillis": "1800000000000"}, False)["tradeTime"], 1_800_000_000_000)

    def test_in_memory_auth_initial_tick_and_disconnect_cleanup(self):
        messages = []
        instances = []
        packet = StocksSocketResponseProtoDto()
        packet.stockLivePrice.tsInMillis = 1_800_000_000_000
        packet.stockLivePrice.ltp = 123.5

        class Client:
            is_closed = False

            def __init__(self):
                instances.append(self)

            async def connect(self, **kwargs):
                self.options = kwargs
                assert kwargs["user_jwt_cb"]() == b"fake-test-socket-jwt"
                assert isinstance(kwargs["nkeys_seed_str"], str)
                assert "user_credentials" not in kwargs and "nkeys_seed" not in kwargs

            async def subscribe(self, topic, cb):
                self.topic = topic
                await cb(SimpleNamespace(data=packet.SerializeToString()))

            async def flush(self, timeout):
                asyncio.get_running_loop().call_soon(lambda: asyncio.create_task(self.options["disconnected_cb"]()))

            async def close(self):
                self.is_closed = True
                await self.options["closed_cb"]()

        with patch.object(GrowwAPI, "generate_socket_token", return_value={"token": "fake-test-socket-jwt"}), patch("nats.aio.client.Client", Client), patch.object(feed, "emit", messages.append):
            asyncio.run(feed.run({
                "accessToken": "fake-test-access-token", "exchange": "NSE", "segment": "CASH",
                "exchangeToken": "2885", "instrumentType": "EQ",
            }))
        self.assertEqual([message["type"] for message in messages], ["connected", "tick", "error"])
        self.assertEqual(messages[-1], {"type": "error", "code": 502})
        self.assertTrue(instances[0].is_closed)
        self.assertEqual(instances[0].topic, FeedConstants.get_live_price_topic("CASH", "NSE", "2885").get_topic())


if __name__ == "__main__":
    unittest.main()
