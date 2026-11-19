def split_discord_message(text: str, limit: int = 2000) -> list[str]:
    if limit < 1:
        raise ValueError("limit must be positive")

    remaining = str(text)
    chunks = []
    while len(remaining) > limit:
        split_at = remaining.rfind("\n", 0, limit + 1)
        if split_at >= 0:
            split_at += 1
        else:
            split_at = remaining.rfind(" ", 0, limit + 1)
            if split_at >= 0:
                split_at += 1
            else:
                split_at = limit
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    if remaining:
        chunks.append(remaining)
    return chunks
