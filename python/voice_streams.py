"""Route Discord PCM and final transcripts by the source account, including during overlap."""
import asyncio
import itertools
import re
import logging
from contextlib import AsyncExitStack, aclosing

_TURN_ORDER = itertools.count()


def is_capri_addressed(text):
    return bool(re.search(r"(?<!\w)capri(?![\w'’])", text, re.I))


async def enqueue_turn(turns, user_id, name, text):
    priority = 0 if is_capri_addressed(text) else 1
    await turns.put((priority, next(_TURN_ORDER), user_id, name, text))


async def receive_turns(live, user_id, name, turns):
    while True:
        received = False
        async for response in live.receive():
            received = True
            content = getattr(response, "server_content", None)
            final = getattr(content, "input_transcription", None)
            text = (getattr(final, "text", "") or "").strip()
            if text:
                await enqueue_turn(turns, user_id, name, text)
        if not received:
            raise ConnectionError("Transcription socket closed")


async def send_frames(live, frames, make_blob, idle_seconds=None):
    streaming = False
    while True:
        try:
            first = await asyncio.wait_for(frames.get(), 0.35 if streaming else idle_seconds)
        except TimeoutError:
            if not streaming:
                return
            await live.send_realtime_input(audio_stream_end=True)
            streaming = False
            continue
        streaming = True
        chunk = bytearray(first)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 0.1
        while len(chunk) < 3200 and deadline > loop.time():
            try:
                chunk.extend(await asyncio.wait_for(frames.get(), deadline - loop.time()))
            except TimeoutError:
                break
        await live.send_realtime_input(audio=make_blob(bytes(chunk)))


async def speaker_streams(audio, turns, warm_socket, connect, make_blob, notify):
    streams = {}
    warm = warm_socket

    async def listen(uid, name, frames, socket):
        try:
            async with AsyncExitStack() as stack:
                live = socket or await stack.enter_async_context(connect())
                tasks = [asyncio.create_task(send_frames(live, frames, make_blob)),
                         asyncio.create_task(receive_turns(live, uid, name, turns))]
                try:
                    done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except Exception:
            logging.exception("Voice transcription for %s", uid)
            await notify("Lost your voice feed for a beat. Say that last part again?")
        finally:
            streams.pop(uid, None)

    try:
        while True:
            uid, name, pcm = await audio.get()
            if not uid:
                continue
            if uid not in streams:
                frames = asyncio.Queue()
                task = asyncio.create_task(listen(uid, name, frames, warm))
                warm = None  # Never reuse one speaker’s socket for another speaker.
                streams[uid] = frames, task
            frames, _ = streams[uid]
            await frames.put(pcm)
    finally:
        tasks = [task for _, task in streams.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def split_for_speech(text):
    """Release sentence or clause-sized speech while the model is still generating."""
    for match in re.finditer(r"(?<=[.!?;,])\s+(?=\S)", text):
        phrase = text[:match.start()].strip()
        if phrase.endswith((".", "!", "?")) or len(phrase) >= 20:
            return phrase, text[match.end():]
    if len(text) > 72:
        split_at = text.rfind(" ", 0, 73)
        if split_at >= 20:
            return text[:split_at].strip(), text[split_at + 1:]
    return "", text


async def stream_sentences(deltas, speak):
    pending = ""
    spoken = []
    async with aclosing(deltas) as stream:
        async for delta in stream:
            pending += delta
            while True:
                sentence, pending = split_for_speech(pending)
                if not sentence:
                    break
                await speak(sentence)
                spoken.append(sentence)
    if pending.strip():
        await speak(pending.strip())
        spoken.append(pending.strip())
    return " ".join(spoken)


async def stream_reply_with_retry(first, retry, speak):
    answer = await stream_sentences(first, speak)
    if answer:
        return answer
    return await stream_sentences(retry(), speak)


async def stream_reply_with_fallback(primary, fallback, speak):
    spoken = []

    async def track_speech(text):
        spoken.append(text)
        await speak(text)

    try:
        answer = await primary(track_speech)
    except Exception as exc:
        if spoken:
            logging.warning("Voice response provider failed after partial speech (%s)", type(exc).__name__)
            return " ".join(spoken)
        if fallback is None:
            raise
        logging.warning(
            "Voice response provider failed before speech (%s: %s); trying fallback",
            type(exc).__name__,
            exc,
        )
    else:
        if answer:
            return answer
        if spoken:
            return " ".join(spoken)
        if fallback is None:
            return ""

    try:
        answer = await fallback(track_speech)
    except Exception:
        if spoken:
            return " ".join(spoken)
        raise
    return answer or " ".join(spoken)
