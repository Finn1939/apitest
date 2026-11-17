def select_chat_provider(ai_provider: str, gemini_chat_key: str) -> str:
    if ai_provider == "gemini" or (ai_provider == "auto" and bool(gemini_chat_key)):
        return "gemini"
    return "openai"
