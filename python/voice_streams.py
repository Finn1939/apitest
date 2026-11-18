"""Route Discord PCM and final transcripts by the source account, including during overlap."""
import asyncio
import re
import logging
from contextlib import AsyncExitStack, aclosing


async def receive_turns(live, user_id, name, turns):
    while True:
        received = False
        async for response in live.receive():
            received = True
            content = getattr(response, "server_content", None)
            final = getattr(content, "input_transcription", None)
            text = (getattr(final, "text", "") or "").strip()
            if text:
                await turns.put((user_id, name, text))
        if not received:
            raise ConnectionError("Transcription socket closed")


async def send_frames(live, frames, make_blob, idle_seconds=60):
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
                tasks = [asyncio.create_task(send_frames(live, frames, make_blob, None if socket else 60)),
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
                frames = asyncio.Queue(maxsize=250)
                task = asyncio.create_task(listen(uid, name, frames, warm))
                warm = None  # Never reuse one speaker’s socket for another speaker.
                streams[uid] = frames, task
            frames, _ = streams[uid]
            if not frames.full():
                frames.put_nowait(pcm)
    finally:
        tasks = [task for _, task in streams.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def split_for_speech(text):
    """Release complete sentences while the model is still writing the next one."""
    match = re.search(r"(?<=[.!?])\s+(?=\S)", text)
    if match:
        return text[:match.start()].strip(), text[match.end():]
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
