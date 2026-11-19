import asyncio
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

from voice_streams import (
    receive_turns,
    enqueue_turn,
    is_capri_addressed,
    send_frames,
    speaker_streams,
    stream_reply_with_fallback,
    stream_reply_with_retry,
    stream_sentences,
)


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
    def test_only_direct_capri_address_counts_as_addressed(self):
        self.assertTrue(is_capri_addressed("Capri, what do you think?"))
        self.assertTrue(is_capri_addressed("Hey CAPRI"))
        self.assertFalse(is_capri_addressed("That was Capri's idea"))
        self.assertFalse(is_capri_addressed("What do you think?"))

    async def test_overlap_attributes_delayed_result_to_original_account(self):
        audio, turns = asyncio.Queue(), asyncio.PriorityQueue()
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
            self.assertEqual((await asyncio.wait_for(turns.get(), 1))[2:], (22, "same name", "Capri ban someone"))
            await owner.transcribe(final="What did I miss?")
            self.assertEqual((await asyncio.wait_for(turns.get(), 1))[2:], (11, "same name", "What did I miss?"))
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_interim_is_ignored_and_next_final_still_works(self):
        live, turns = Socket(), asyncio.PriorityQueue()
        task = asyncio.create_task(receive_turns(live, 11, "Kei", turns))
        try:
            await live.transcribe(interim="Capri delete")
            await live.transcribe(final="Capri delete nothing")
            await live.transcribe(final="Hello again")
            for line in ["Capri delete nothing", "Hello again"]:
                self.assertEqual((await asyncio.wait_for(turns.get(), 1))[4], line)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_capri_addressed_turns_are_prioritized_in_fifo_order(self):
        turns = asyncio.PriorityQueue()
        await enqueue_turn(turns, 11, "First", "Hello everyone")
        await enqueue_turn(turns, 22, "Second", "Capri, help me")
        await enqueue_turn(turns, 33, "Third", "Capri, listen")

        self.assertEqual((await turns.get())[2:], (22, "Second", "Capri, help me"))
        self.assertEqual((await turns.get())[2:], (33, "Third", "Capri, listen"))
        self.assertEqual((await turns.get())[2:], (11, "First", "Hello everyone"))

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

    async def test_clause_is_spoken_before_sentence_finishes(self):
        chunks, first = [], asyncio.Event()

        async def speak(line):
            chunks.append(line)
            first.set()

        async def deltas():
            yield "This is a useful opening clause, and"
            await asyncio.wait_for(first.wait(), 0.5)
            yield " here is the rest."

        self.assertEqual(
            await stream_sentences(deltas(), speak),
            "This is a useful opening clause, and here is the rest.",
        )
        self.assertEqual(chunks, ["This is a useful opening clause,", "and here is the rest."])

    async def test_empty_voice_reply_retries_once(self):
        spoken = []

        async def speak(line):
            spoken.append(line)

        async def empty():
            if False:
                yield ""

        async def retry():
            yield "I'm here."

        self.assertEqual(await stream_reply_with_retry(empty(), retry, speak), "I'm here.")
        self.assertEqual(spoken, ["I'm here."])

    async def test_empty_voice_reply_retries_only_once(self):
        calls = 0

        async def empty():
            if False:
                yield ""

        def retry():
            nonlocal calls
            calls += 1
            return empty()

        self.assertEqual(await stream_reply_with_retry(empty(), retry, AsyncMock()), "")
        self.assertEqual(calls, 1)

    async def test_voice_provider_error_uses_chat_provider_fallback(self):
        spoken = []

        async def primary(_speak):
            raise RuntimeError("primary unavailable")

        async def fallback(speak):
            await speak("I heard you.")
            return "I heard you."

        async def speak(line):
            spoken.append(line)

        answer = await stream_reply_with_fallback(primary, fallback, speak)

        self.assertEqual(answer, "I heard you.")
        self.assertEqual(spoken, ["I heard you."])

    async def test_partial_voice_reply_is_not_replayed_by_fallback(self):
        spoken = []
        fallback_calls = 0

        async def speak(line):
            spoken.append(line)

        async def primary(speak):
            await speak("First part.")
            raise TimeoutError

        async def fallback(_speak):
            nonlocal fallback_calls
            fallback_calls += 1
            return "A duplicate full reply."

        answer = await stream_reply_with_fallback(primary, fallback, speak)

        self.assertEqual(answer, "First part.")
        self.assertEqual(spoken, ["First part."])
        self.assertEqual(fallback_calls, 0)
