import unittest

from provider_config import select_chat_provider


class TestChatProviderSelection(unittest.TestCase):
    def test_explicit_nvidia_chat_is_independent_of_gemini_voice_key(self):
        self.assertEqual(select_chat_provider("openai", "gemini-chat-key"), "openai")

    def test_auto_uses_gemini_chat_only_when_chat_key_is_present(self):
        self.assertEqual(select_chat_provider("auto", "gemini-chat-key"), "gemini")
        self.assertEqual(select_chat_provider("auto", ""), "openai")
if __name__ == "__main__":
    unittest.main()
