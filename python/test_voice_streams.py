import asyncio
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

from voice_streams import receive_turns, send_frames, speaker_streams, stream_sentences


class Socket:
    def __init__(self):
        self.frames = asyncio.Queue()
        self.events = asyncio.Queue()

    async def send_realtime_input(self, **kwargs):
        await self.frames.put(kwargs)

    async def receive(self):
        yield await self.events.get()

    async def transcribe(self, final=None, interim=None):
        def part(text):
            return SimpleNamespace(text=text) if text else None
        await self.events.put(SimpleNamespace(server_content=SimpleNamespace(
            input_transcription=part(final), interim_input_transcription=part(interim))))


class VoiceRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_overlap_attributes_delayed_result_to_original_account(self):
        audio, turns = asyncio.Queue(), asyncio.Queue()
        owner, guest = Socket(), Socket()

        @asynccontextmanager
        async def connect():
            yield guest

        task = asyncio.create_task(speaker_streams(audio, turns, owner, connect, bytes, AsyncMock()))
        try:
            await audio.put((11, "same name", b"a"*1600))
            await audio.put((22, "same name", b"b"*3200))
            await audio.put((11, "same name", b"c"*1600))
            self.assertEqual(await asyncio.wait_for(owner.frames.get(), 1), {"audio": b"a"*1600 + b"c"*1600})
            self.assertEqual(await asyncio.wait_for(guest.frames.get(), 1), {"audio": b"b"*3200})
            await guest.transcribe(final="Capri ban someone")
            self.assertEqual(await asyncio.wait_for(turns.get(), 1), (22, "same name", "Capri ban someone"))
            await owner.transcribe(final="What did I miss?")
            self.assertEqual(await asyncio.wait_for(turns.get(), 1), (11, "same name", "What did I miss?"))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_interim_is_ignored_and_next_final_still_works(self):
        live, turns = Socket(), asyncio.Queue()
        task = asyncio.create_task(receive_turns(live, 11, "Kei", turns))
        try:
            await live.transcribe(interim="Capri delete")
            await live.transcribe(final="Capri delete nothing")
            await live.transcribe(final="Hello again")
            for line in ["Capri delete nothing", "Hello again"]:
                self.assertEqual((await asyncio.wait_for(turns.get(), 1))[2], line)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_short_audio_flushes_and_resumes_after_pause(self):
        live, frames = Socket(), asyncio.Queue()
        task = asyncio.create_task(send_frames(live, frames, bytes, idle_seconds=2))
        try:
            await frames.put(b"short")
            self.assertEqual(await asyncio.wait_for(live.frames.get(), 1), {"audio": b"short"})
            self.assertEqual(await asyncio.wait_for(live.frames.get(), 1), {"audio_stream_end": True})
            await frames.put(b"new")
            self.assertEqual(await asyncio.wait_for(live.frames.get(), 1), {"audio": b"new"})
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_first_sentence_spoken_before_generation_finishes(self):
        chunks, first = [], asyncio.Event()
        async def speak(line):
            chunks.append(line)
            first.set()
        async def deltas():
            yield "Hey. I"
            await asyncio.wait_for(first.wait(), 0.5)
            yield " heard you."
        self.assertEqual(await stream_sentences(deltas(), speak), "Hey. I heard you.")
        self.assertEqual(chunks, ["Hey.", "I heard you."])
