import unittest

from discord_text import split_discord_message


class DiscordMessageSplitTests(unittest.TestCase):
    def test_long_text_splits_without_dropping_content(self):
        text = "first line\n" + ("word " * 500)
        chunks = split_discord_message(text, limit=30)
        self.assertTrue(all(len(chunk) <= 30 for chunk in chunks))
        self.assertEqual("".join(chunks), text)

    def test_long_unbroken_text_splits_at_the_platform_limit(self):
        text = "x" * 25
        chunks = split_discord_message(text, limit=10)
        self.assertEqual(chunks, ["x" * 10, "x" * 10, "x" * 5])

    def test_rejects_nonpositive_limit(self):
        with self.assertRaises(ValueError):
            split_discord_message("text", limit=0)


if __name__ == "__main__":
    unittest.main()
