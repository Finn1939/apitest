from __future__ import annotations

import array
import asyncio
import inspect
import math
import sys
import threading
import time
from typing import Any, Awaitable, Callable

import aiohttp
from google.genai import types

try:
    import discord

    _AUDIO_SOURCE_BASE: type = discord.AudioSource
except ImportError:
    discord = None  # type: ignore

    class _FallbackAudioSource:
        def cleanup(self) -> None:
            pass

    _AUDIO_SOURCE_BASE = _FallbackAudioSource

try:
    from discord.ext import voice_recv  # type: ignore
    from dave_receive import install_dave_receive_patch

    install_dave_receive_patch()

    HAS_VOICE_RECV = True
except Exception as exc:
    voice_recv = None  # type: ignore
    HAS_VOICE_RECV = False
    print(f"[Capri voice receive unavailable] {type(exc).__name__}: {str(exc).strip() or repr(exc)}")

DISCORD_FRAME_BYTES = 3840  # 20ms @ 48kHz, 16-bit stereo PCM (960 * 2 * 2)
MAX_BUFFER_BYTES = 48000 * 4 * 12  # ~12 seconds cap in RAM, zero disk storage
ASR_CONNECT_TIMEOUT_SECONDS = 20
VOICE_INPUT_TIMEOUT_SECONDS = 30
FISH_TTS_URL = "https://api.fish.audio/v1/tts"
FISH_SAMPLE_RATE = 24000
DISCORD_SAMPLE_RATE = 48000
TEST_TONE_DURATION_SECONDS = 2
TEST_TONE_FREQUENCY_HZ = 440


def _pcm_to_int16_array(pcm_bytes: bytes, unit_bytes: int) -> array.array:
    usable = (len(pcm_bytes) // unit_bytes) * unit_bytes
    arr = array.array("h")
    arr.frombytes(pcm_bytes[:usable])
    if sys.byteorder == "big":
        arr.byteswap()
    return arr


def _int16_array_to_pcm(arr: array.array) -> bytes:
    if sys.byteorder == "big":
        out = array.array("h", arr)
        out.byteswap()
        return out.tobytes()
    return arr.tobytes()


def _exception_detail(exc: Exception) -> str:
    return str(exc).strip() or repr(exc)


def resample_48k_stereo_to_16k_mono(pcm_48k_stereo: bytes) -> bytes:
    """Convert Discord 48kHz 16-bit stereo LE PCM -> Gemini ASR 16kHz 16-bit mono LE PCM.

    Pure in-memory 3:1 box-averaged downsample + stereo-to-mono downmix.
    Zero temp files, zero FFmpeg subprocesses, Python 3.10-3.13+ safe.
    """
    if len(pcm_48k_stereo) < 12:
        return b""
    # Align to groups of 3 stereo frames (3 * 4 bytes = 12 bytes -> 1 output sample)
    usable = (len(pcm_48k_stereo) // 12) * 12
    samples = _pcm_to_int16_array(pcm_48k_stereo[:usable], 12)
    out = array.array("h")
    total = len(samples)
    for idx in range(0, total, 6):
        m0 = (samples[idx] + samples[idx + 1]) >> 1
        m1 = (samples[idx + 2] + samples[idx + 3]) >> 1
        m2 = (samples[idx + 4] + samples[idx + 5]) >> 1
        out.append((m0 + m1 + m2) // 3)
    return _int16_array_to_pcm(out)


def resample_24k_mono_to_48k_stereo(pcm_24k_mono: bytes, prev_sample: int = 0) -> tuple[bytes, int]:
    """Convert Fish TTS 24kHz 16-bit mono LE PCM -> Discord 48kHz 16-bit stereo LE PCM.

    Pure in-memory 1:2 linear-interpolated upsample + mono-to-stereo duplication.
    Returns (pcm_48k_stereo_bytes, last_sample_for_next_chunk).
    """
    if len(pcm_24k_mono) < 2:
        return b"", prev_sample
    samples = _pcm_to_int16_array(pcm_24k_mono, 2)
    out = array.array("h")
    prev = prev_sample
    for s in samples:
        mid = (prev + s) >> 1
        out.append(mid)
        out.append(mid)
        out.append(s)
        out.append(s)
        prev = s
    return _int16_array_to_pcm(out), prev


def pcm_rms(pcm_bytes: bytes) -> float:
    """Fast RMS energy estimate on signed 16-bit LE PCM bytes (for lightweight noise-gate VAD)."""
    if len(pcm_bytes) < 2:
        return 0.0
    samples = _pcm_to_int16_array(pcm_bytes, 2)
    if not samples:
        return 0.0
    step = max(1, len(samples) // 80)
    acc = 0
    cnt = 0
    for i in range(0, len(samples), step):
        v = samples[i]
        acc += v * v
        cnt += 1
    return (acc / max(1, cnt)) ** 0.5


def pcm_rms_full(pcm_bytes: bytes) -> float:
    """Return RMS across every signed 16-bit LE PCM sample."""
    samples = _pcm_to_int16_array(pcm_bytes, 2)
    if not samples:
        return 0.0
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def make_test_tone_48k_stereo() -> bytes:
    """Generate a two-second, 440 Hz, 25%-amplitude tone for Discord playback tests."""
    frames = DISCORD_SAMPLE_RATE * TEST_TONE_DURATION_SECONDS
    amplitude = int(32767 * 0.25)
    samples = array.array("h")
    for frame in range(frames):
        sample = int(
            amplitude
            * math.sin(2 * math.pi * TEST_TONE_FREQUENCY_HZ * frame / DISCORD_SAMPLE_RATE)
        )
        samples.extend((sample, sample))
    return _int16_array_to_pcm(samples)


DAVE_READY_TIMEOUT_SECONDS = 15.0


class VoiceAudioSource(_AUDIO_SOURCE_BASE):  # type: ignore[misc]
    """Continuous 48kHz stereo PCM AudioSource fed directly from RAM."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buf = bytearray()
        self._prev_sample = 0
        self._closed = False
        self.is_speaking = False
        self._audio_frames_read = 0
        self._audio_non_silent_frames_read = 0
        self._last_audio_rms = 0.0

    def is_opus(self) -> bool:
        return False

    def enqueue_24k_mono(self, pcm_24k: bytes) -> None:
        if not pcm_24k or self._closed:
            return
        with self._lock:
            chunk, self._prev_sample = resample_24k_mono_to_48k_stereo(pcm_24k, self._prev_sample)
            if chunk:
                self._buf.extend(chunk)
                if len(self._buf) > MAX_BUFFER_BYTES:
                    excess = len(self._buf) - MAX_BUFFER_BYTES
                    # Keep 4-byte stereo alignment
                    excess -= excess % 4
                    if excess > 0:
                        del self._buf[:excess]

    def enqueue_48k_stereo(self, pcm_48k: bytes) -> None:
        if not pcm_48k or self._closed:
            return
        with self._lock:
            self._buf.extend(pcm_48k)

    def clear(self) -> None:
        with self._lock:
            self._buf.clear()
            self._prev_sample = 0
            self.is_speaking = False

    def buffered_bytes(self) -> int:
        with self._lock:
            return len(self._buf)

    def audio_frames_read(self) -> int:
        with self._lock:
            return self._audio_frames_read

    def audio_non_silent_frames_read(self) -> int:
        with self._lock:
            return self._audio_non_silent_frames_read

    def last_audio_rms(self) -> float:
        with self._lock:
            return self._last_audio_rms

    def read(self) -> bytes:
        with self._lock:
            if self._closed:
                return b""
            available = len(self._buf)
            if available >= DISCORD_FRAME_BYTES:
                frame = bytes(self._buf[:DISCORD_FRAME_BYTES])
                del self._buf[:DISCORD_FRAME_BYTES]
                self.is_speaking = True
                self._audio_frames_read += 1
                if any(frame):
                    self._audio_non_silent_frames_read += 1
                self._last_audio_rms = pcm_rms_full(frame)
                return frame
            if available > 0:
                frame = bytes(self._buf) + (b"\x00" * (DISCORD_FRAME_BYTES - available))
                self._buf.clear()
                self.is_speaking = True
                self._audio_frames_read += 1
                if any(frame):
                    self._audio_non_silent_frames_read += 1
                self._last_audio_rms = pcm_rms_full(frame)
                return frame
            self.is_speaking = False
            return b"\x00" * DISCORD_FRAME_BYTES

    def cleanup(self) -> None:
        self._closed = True
        self.clear()


def _make_voice_sink(
    loop: asyncio.AbstractEventLoop,
    on_pcm: Callable[[int, str, bytes], None],
    vad_threshold: float,
) -> Any:
    if not HAS_VOICE_RECV or voice_recv is None:
        return None

    class CapriVoiceSink(voice_recv.AudioSink):  # type: ignore[misc]
        def __init__(self) -> None:
            super().__init__()
            self._hangover_until: dict[int, float] = {}

        def wants_opus(self) -> bool:
            return False

        def write(self, user: discord.User | discord.Member | None, data: Any) -> None:
            if user is None or getattr(user, "bot", False):
                return
            pcm_48k = getattr(data, "pcm", b"")
            if not pcm_48k:
                return
            pcm_16k = resample_48k_stereo_to_16k_mono(pcm_48k)
            if not pcm_16k:
                return
            now = time.monotonic()
            uid = int(user.id)
            if pcm_rms(pcm_16k) >= vad_threshold:
                self._hangover_until[uid] = now + 0.85
            elif now > self._hangover_until.get(uid, 0.0):
                return
            speaker_name = getattr(user, "display_name", None) or getattr(user, "name", None) or str(uid)
            try:
                loop.call_soon_threadsafe(on_pcm, uid, speaker_name, pcm_16k)
            except RuntimeError:
                pass

        def cleanup(self) -> None:
            self._hangover_until.clear()

    return CapriVoiceSink()


class CapriVoiceSession:
    """Runs Gemini realtime transcription and Fish speech inside a Discord voice channel."""

    def __init__(
        self,
        *,
        guild: discord.Guild,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
        fish_api_key: str,
        reference_id: str,
        gemini_client: Any = None,
        enable_asr: bool = True,
        asr_model: str = "gemini-3.5-transcribe-live",
        tts_model: str = "s2.1-pro-free",
        vad_threshold: float = 110.0,
        text_channel: Any = None,
        on_transcript: Callable[[int, str, str, bool], Awaitable[None] | None] | None = None,
        on_user_turn: Callable[[int, str, str], Awaitable[str | None] | str | None] | None = None,
    ) -> None:
        self.guild = guild
        self.voice_channel = voice_channel
        self.fish_api_key = fish_api_key
        self.reference_id = reference_id
        self.gemini_client = gemini_client
        self.enable_asr = enable_asr
        self.asr_model = asr_model
        self.tts_model = tts_model
        self.vad_threshold = vad_threshold
        self.text_channel = text_channel
        self.on_transcript = on_transcript
        self.on_user_turn = on_user_turn

        self.audio_source = VoiceAudioSource()
        self.voice_client: discord.VoiceClient | None = None
        self.sink: Any = None
        self._audio_queue: asyncio.Queue[tuple[int, str, bytes]] = asyncio.Queue(maxsize=250)
        self._turn_queue: asyncio.Queue[tuple[int, str, str]] = asyncio.Queue(maxsize=20)
        self._speech_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=20)
        self._stop_event = asyncio.Event()
        self._ready_event = asyncio.Event()
        self._audio_received_event = asyncio.Event()
        self._session_error: Exception | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._response_task: asyncio.Task[None] | None = None
        self._speech_task: asyncio.Task[None] | None = None
        self._last_speaker_id: int | None = None
        self._last_speaker_name = ""
        self._tts_requests = 0
        self._tts_successes = 0
        self._tts_audio_bytes = 0
        self._last_tts_error: str | None = None
        self._playback_errors = 0
        self._last_playback_error: str | None = None

    @property
    def is_connected(self) -> bool:
        return bool(self.voice_client and self.voice_client.is_connected() and not self._stop_event.is_set())

    def _push_pcm_from_thread(self, user_id: int, speaker_name: str, pcm_16k: bytes) -> None:
        if self._stop_event.is_set():
            return
        self._audio_received_event.set()
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            self._audio_queue.put_nowait((user_id, speaker_name, pcm_16k))
        except asyncio.QueueFull:
            pass

    async def start(self) -> bool:
        loop = asyncio.get_running_loop()
        try:
            if self.enable_asr and HAS_VOICE_RECV and voice_recv is not None:
                self.voice_client = await self.voice_channel.connect(cls=voice_recv.VoiceRecvClient, self_deaf=False)
            else:
                self.voice_client = await self.voice_channel.connect(self_deaf=False)

            if not self.voice_client.is_playing():
                self.voice_client.play(
                    self.audio_source,
                    after=self._record_playback_error,
                )

            if self.enable_asr and HAS_VOICE_RECV and hasattr(self.voice_client, "listen"):
                self.sink = _make_voice_sink(loop, self._push_pcm_from_thread, self.vad_threshold)
                if self.sink is not None:
                    self.voice_client.listen(self.sink)  # type: ignore[attr-defined]
        except asyncio.CancelledError:
            await self.stop()
            raise
        except Exception as exc:
            await self.stop()
            raise RuntimeError(
                f"Discord voice setup failed ({type(exc).__name__}): {_exception_detail(exc)}"
            ) from exc

        self._runner_task = asyncio.create_task(self._run_session_loop(), name=f"capri-vc-{self.guild.id}")
        try:
            await asyncio.wait_for(self._ready_event.wait(), timeout=ASR_CONNECT_TIMEOUT_SECONDS)
        except TimeoutError as exc:
            await self.stop()
            raise RuntimeError(
                f"Timed out after {ASR_CONNECT_TIMEOUT_SECONDS} seconds waiting for Gemini Live "
                f"transcription model `{self.asr_model}` to connect."
            ) from exc

        if self._session_error is not None:
            error = self._session_error
            await self.stop()
            raise RuntimeError(f"Gemini Live ASR connection failed: {_exception_detail(error)}") from error
        if self._runner_task.done():
            await self.stop()
            raise RuntimeError("Gemini Live voice session ended during startup.")
        return self.enable_asr and self.sink is not None

    async def say_text(self, text: str) -> None:
        clean = " ".join(str(text or "").split()).strip()
        if clean and not self._stop_event.is_set():
            await self._speech_queue.put(clean)

    def dave_state(self) -> tuple[int, bool, bool]:
        """Return (protocol_version, session_ready, can_encrypt) for the voice connection."""
        conn = getattr(self.voice_client, "_connection", None)
        version = int(getattr(conn, "dave_protocol_version", 0) or 0)
        dave = getattr(conn, "dave_session", None)
        ready = bool(getattr(dave, "ready", False))
        can_encrypt = bool(getattr(conn, "can_encrypt", False))
        return version, ready, can_encrypt

    def dave_blocking_audio(self) -> bool:
        """True when the channel negotiated DAVE E2EE but we cannot encrypt yet.

        Frames sent in that state carry no DAVE layer, so other clients drop them
        and listeners hear silence even though local playback counters advance.
        """
        version, _ready, can_encrypt = self.dave_state()
        return version > 0 and not can_encrypt

    async def wait_for_dave(self, timeout: float = DAVE_READY_TIMEOUT_SECONDS) -> bool:
        deadline = asyncio.get_running_loop().time() + timeout
        while self.dave_blocking_audio():
            if self._stop_event.is_set() or asyncio.get_running_loop().time() >= deadline:
                return False
            await asyncio.sleep(0.25)
        return True

    def enqueue_test_tone(self) -> bool:
        if self._stop_event.is_set():
            return False
        self.audio_source.enqueue_48k_stereo(make_test_tone_48k_stereo())
        return True

    def _record_playback_error(self, error: Exception | None) -> None:
        if error is None:
            return
        self._playback_errors += 1
        self._last_playback_error = _exception_detail(error)
        print(
            f"[Capri voice playback error] {type(error).__name__}: {self._last_playback_error}",
            flush=True,
        )

    async def _emit_transcript(self, speaker_id: int, speaker_name: str, text: str, is_bot: bool) -> None:
        clean = " ".join(text.split()).strip()
        if not clean or not self.on_transcript:
            return
        try:
            result = self.on_transcript(speaker_id, speaker_name, clean, is_bot)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            print(f"[Capri voice transcript callback error] {type(exc).__name__}: {_exception_detail(exc)}")

    async def _run_session_loop(self) -> None:
        try:
            if not self.enable_asr:
                self._ready_event.set()
                await self._run_voice_workers()
                return
            if self.sink is None:
                self._ready_event.set()
                await self._notify_text_channel(
                    "Voice listening isn't available right now. You can still chat with Capri here "
                    "or use `/vc_say` for voice output."
                )
                await self._run_voice_workers()
                return
            if self.gemini_client is None:
                raise RuntimeError("Set GEMINI_API_KEY to enable Gemini Live transcription.")
            async with self.gemini_client.aio.live.connect(
                model=self.asr_model,
                config={
                    "response_modalities": ["TEXT"],
                    "input_audio_transcription": {"language_codes": []},
                },
            ) as live_session:
                self._ready_event.set()
                await self._run_voice_workers(live_session)
        except asyncio.CancelledError:
            self._ready_event.set()
            raise
        except Exception as exc:
            self._session_error = exc
            self._ready_event.set()
            detail = _exception_detail(exc)
            print(f"[Capri Gemini voice error] {type(exc).__name__}: {detail}")
            await self._notify_text_channel(
                "Gemini Live transcription failed; the voice session disconnected. "
                f"Text fallback: mention Capri here to continue chatting. Details: `{detail[:1000]}`"
            )
        finally:
            await self.stop()

    async def _run_voice_workers(self, live_session: Any = None) -> None:
        workers: list[asyncio.Task[Any]] = []
        input_watchdog: asyncio.Task[None] | None = None
        if live_session is not None:
            workers.extend([
                asyncio.create_task(self._send_audio_loop(live_session)),
                asyncio.create_task(self._receive_asr_loop(live_session)),
            ])
            input_watchdog = asyncio.create_task(self._watch_initial_voice_input())
        workers.extend([
            asyncio.create_task(self._respond_loop()),
            asyncio.create_task(self._speak_loop()),
            asyncio.create_task(self._stop_event.wait()),
        ])
        try:
            done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
            if not self._stop_event.is_set():
                for task in done:
                    if task.cancelled():
                        continue
                    error = task.exception()
                    if error is not None:
                        self._session_error = error
                        detail = _exception_detail(error)
                        print(f"[Capri voice task error] {type(error).__name__}: {detail}")
                        await self._notify_text_channel(
                            f"Voice listening stopped: `{detail[:800]}`. "
                            "Text fallback: mention Capri here to continue chatting."
                        )
                        break
                if self._session_error is None:
                    self._session_error = RuntimeError("Voice session ended unexpectedly.")
        finally:
            tasks_to_clean = workers + ([input_watchdog] if input_watchdog is not None else [])
            for task in tasks_to_clean:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks_to_clean, return_exceptions=True)

    async def _watch_initial_voice_input(self) -> None:
        try:
            await asyncio.wait_for(
                self._audio_received_event.wait(),
                timeout=VOICE_INPUT_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            if not self._stop_event.is_set():
                await self._notify_text_channel(
                    "I haven't received voice audio yet. If you spoke and I didn't hear you, "
                    "mention Capri here to continue in text."
                )

    async def _send_audio_loop(self, live_session: Any) -> None:
        while not self._stop_event.is_set():
            user_id, speaker_name, first_frame = await self._audio_queue.get()
            pcm_16k = bytearray(first_frame)
            deadline = asyncio.get_running_loop().time() + 0.1
            while len(pcm_16k) < 3200:
                delay = deadline - asyncio.get_running_loop().time()
                if delay <= 0:
                    break
                try:
                    user_id, speaker_name, audio_frame = await asyncio.wait_for(
                        self._audio_queue.get(),
                        timeout=delay,
                    )
                except TimeoutError:
                    break
                self._last_speaker_id = user_id
                self._last_speaker_name = speaker_name
                pcm_16k.extend(audio_frame)

            self._last_speaker_id = user_id
            self._last_speaker_name = speaker_name
            await live_session.send_realtime_input(
                audio=types.Blob(data=bytes(pcm_16k), mime_type="audio/pcm;rate=16000")
            )

    async def _receive_asr_loop(self, live_session: Any) -> None:
        async for response in live_session.receive():
            content = getattr(response, "server_content", None)
            transcription = getattr(content, "input_transcription", None)
            text = str(getattr(transcription, "text", "") or "").strip()
            if text:
                await self._turn_queue.put((
                    self._last_speaker_id or 0,
                    self._last_speaker_name or "Crew",
                    text,
                ))
        if not self._stop_event.is_set():
            raise RuntimeError("Gemini Live transcription connection closed.")

    def _interrupt_speech(self) -> None:
        self.audio_source.clear()
        for task in (self._response_task, self._speech_task):
            if task and not task.done():
                task.cancel()
        for queue in (self._turn_queue, self._speech_queue):
            while not queue.empty():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

    async def _respond_loop(self) -> None:
        while not self._stop_event.is_set():
            turn = await self._turn_queue.get()
            await self._emit_transcript(*turn, False)
            task = asyncio.create_task(self._answer_turn(*turn))
            self._response_task = task
            try:
                await task
            except asyncio.CancelledError:
                if self._stop_event.is_set():
                    raise
            except Exception as exc:
                detail = _exception_detail(exc)
                print(f"[Capri voice response error] {type(exc).__name__}: {detail}")
                await self._notify_text_channel(f"Capri voice response failed: `{detail}`")
            finally:
                if self._response_task is task:
                    self._response_task = None

    async def _answer_turn(self, speaker_id: int, speaker_name: str, text: str) -> None:
        if self.on_user_turn is None:
            return
        result = self.on_user_turn(speaker_id, speaker_name, text)
        response = await result if inspect.isawaitable(result) else result
        if response:
            await self._speech_queue.put(str(response))

    async def _speak_loop(self) -> None:
        while not self._stop_event.is_set():
            text = await self._speech_queue.get()
            if not await self.wait_for_dave():
                self._last_tts_error = "DAVE E2EE not ready; audio would be inaudible to listeners"
                print(f"[Capri voice] {self._last_tts_error}", flush=True)
                await self._notify_text_channel(
                    f"Capri can't speak yet (Discord voice encryption isn't ready), so here's the text:\n{text[:1800]}"
                )
                continue
            task = asyncio.create_task(self._synthesize_speech(text))
            self._speech_task = task
            self._tts_requests += 1
            self._last_tts_error = None
            try:
                audio_bytes = await task
                self._tts_successes += 1
                self._tts_audio_bytes += audio_bytes
                print(
                    f"[Capri Fish TTS] success model={self.tts_model} response_bytes={audio_bytes} "
                    f"buffered_bytes={self.audio_source.buffered_bytes()}"
                )
            except asyncio.CancelledError:
                if self._stop_event.is_set():
                    raise
            except Exception as exc:
                detail = _exception_detail(exc)
                self._last_tts_error = detail
                print(f"[Capri Fish TTS error] {type(exc).__name__}: {detail}")
                await self._notify_text_channel(
                    f"Capri couldn't speak that reply, so here's the text instead:\n{text[:1800]}"
                )
            finally:
                if self._speech_task is task:
                    self._speech_task = None

    async def _synthesize_speech(self, text: str) -> int:
        payload = {
            "text": text,
            "reference_id": self.reference_id,
            "format": "pcm",
            "sample_rate": FISH_SAMPLE_RATE,
            "latency": "balanced",
        }
        headers = {
            "Authorization": f"Bearer {self.fish_api_key}",
            "Content-Type": "application/json",
            "model": self.tts_model,
        }
        total_bytes = 0
        pending = bytearray()
        timeout = aiohttp.ClientTimeout(total=90)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.post(FISH_TTS_URL, headers=headers, json=payload) as response:
                if response.status >= 400:
                    body = (await response.text())[:500]
                    raise RuntimeError(f"Fish TTS returned HTTP {response.status}: {body}")
                async for chunk in response.content.iter_chunked(8192):
                    pending.extend(chunk)
                    complete_length = len(pending) - (len(pending) % 2)
                    if complete_length:
                        pcm = bytes(pending[:complete_length])
                        del pending[:complete_length]
                        self.audio_source.enqueue_24k_mono(pcm)
                        total_bytes += len(pcm)
        if pending:
            raise RuntimeError("Fish TTS returned an incomplete 16-bit PCM sample.")
        if total_bytes == 0:
            raise RuntimeError("Fish TTS returned no audio.")
        await self._emit_transcript(0, "Capri", text, True)
        return total_bytes

    async def _notify_text_channel(self, message: str) -> None:
        if self.text_channel is None:
            return
        try:
            await self.text_channel.send(
                message,
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except Exception as exc:
            print(f"[Capri voice error notification failed] {type(exc).__name__}: {_exception_detail(exc)}")

    async def stop(self) -> None:
        if self._stop_event.is_set():
            return
        self._stop_event.set()
        self.audio_source.cleanup()
        self._interrupt_speech()

        if self.voice_client is not None:
            try:
                if hasattr(self.voice_client, "stop_listening") and self.sink is not None:
                    self.voice_client.stop_listening()  # type: ignore[attr-defined]
            except Exception as exc:
                print(f"[Capri voice listener cleanup error] {type(exc).__name__}: {_exception_detail(exc)}")
            try:
                if self.voice_client.is_playing():
                    self.voice_client.stop()
            except Exception as exc:
                print(f"[Capri voice playback cleanup error] {type(exc).__name__}: {_exception_detail(exc)}")
            try:
                if self.voice_client.is_connected():
                    await self.voice_client.disconnect(force=True)
            except Exception as exc:
                print(f"[Capri Discord disconnect error] {type(exc).__name__}: {_exception_detail(exc)}")
            self.voice_client = None

        current = asyncio.current_task()
        if self._runner_task and self._runner_task is not current and not self._runner_task.done():
            self._runner_task.cancel()
            await asyncio.gather(self._runner_task, return_exceptions=True)


class VoiceSessionManager:
    """Tracks Fish Audio voice sessions keyed by Discord guild ID."""

    def __init__(self) -> None:
        self._sessions: dict[int, CapriVoiceSession] = {}

    def get(self, guild_id: int) -> CapriVoiceSession | None:
        session = self._sessions.get(guild_id)
        if session and session.is_connected:
            return session
        return None

    async def join(
        self,
        *,
        guild: discord.Guild,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
        fish_api_key: str,
        reference_id: str,
        gemini_client: Any = None,
        enable_asr: bool = True,
        asr_model: str = "gemini-3.5-transcribe-live",
        tts_model: str = "s2.1-pro-free",
        vad_threshold: float = 110.0,
        text_channel: Any = None,
        on_transcript: Callable[[int, str, str, bool], Awaitable[None] | None] | None = None,
        on_user_turn: Callable[[int, str, str], Awaitable[str | None] | str | None] | None = None,
    ) -> tuple[CapriVoiceSession, bool]:
        if not fish_api_key:
            raise RuntimeError("Set FISH_AUDIO_API_KEY to enable Fish Audio TTS.")
        if not reference_id:
            raise RuntimeError("Set FISH_AUDIO_REFERENCE_ID to choose Capri's Fish Audio voice.")
        if enable_asr and gemini_client is None:
            raise RuntimeError("Set GEMINI_API_KEY to enable Gemini Live transcription.")

        existing = self._sessions.get(guild.id)
        if existing:
            if existing.is_connected and existing.voice_channel.id == voice_channel.id:
                return existing, existing.sink is not None
            await existing.stop()
            self._sessions.pop(guild.id, None)

        session = CapriVoiceSession(
            guild=guild,
            voice_channel=voice_channel,
            fish_api_key=fish_api_key,
            reference_id=reference_id,
            gemini_client=gemini_client,
            enable_asr=enable_asr,
            asr_model=asr_model,
            tts_model=tts_model,
            vad_threshold=vad_threshold,
            text_channel=text_channel,
            on_transcript=on_transcript,
            on_user_turn=on_user_turn,
        )
        listen_enabled = await session.start()
        self._sessions[guild.id] = session
        return session, listen_enabled

    async def leave(self, guild_id: int) -> bool:
        session = self._sessions.pop(guild_id, None)
        if session is not None:
            await session.stop()
            return True
        return False

    async def say(self, guild_id: int, text: str) -> bool:
        session = self.get(guild_id)
        if session is None:
            return False
        await session.say_text(text)
        return True

    async def close_all(self) -> None:
        for guild_id in list(self._sessions):
            await self.leave(guild_id)
