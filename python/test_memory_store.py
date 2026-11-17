import unittest

import discord

from memory_store import fetch_guild_channels


class FakeGuild:
    name = "test-guild"

    def __init__(self):
        self.channels = ["cached-channel"]

    async def fetch_channels(self):
        raise discord.InvalidData("unknown channel type")


class TestFetchGuildChannels(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_channel_type_falls_back_to_cache(self):
        guild = FakeGuild()
        self.assertEqual(await fetch_guild_channels(guild), ["cached-channel"])


if __name__ == "__main__":
    unittest.main()
