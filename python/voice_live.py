from __future__ import annotations

import array
import asyncio
from collections import defaultdict, deque
import inspect
import msgpack
import sys
import threading
import time
from typing import Any, Awaitable, Callable

import aiohttp
import websockets

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

    HAS_VOICE_RECV = True
except Exception:
    voice_recv = None  # type: ignore
    HAS_VOICE_RECV = False

DISCORD_FRAME_BYTES = 3840  # 20ms @ 48kHz, 16-bit stereo PCM (960 * 2 * 2)
MAX_BUFFER_BYTES = 48000 * 4 * 12  # ~12 seconds cap in RAM, zero disk storage
ASR_CONNECT_TIMEOUT_SECONDS = 20
FISH_ASR_URL = "wss://api.fish.audio/v1/asr/realtime"
FISH_TTS_URL = "https://api.fish.audio/v1/tts"
FISH_SAMPLE_RATE = 24000


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
    """Convert Discord 48kHz 16-bit stereo LE PCM -> Fish ASR 16kHz 16-bit mono LE PCM.

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


class VoiceAudioSource(_AUDIO_SOURCE_BASE):  # type: ignore[misc]
    """Continuous 48kHz stereo PCM AudioSource fed directly from RAM."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buf = bytearray()
        self._prev_sample = 0
        self._closed = False
        self.is_speaking = False

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

    def read(self) -> bytes:
        with self._lock:
            if self._closed:
                return b""
            available = len(self._buf)
            if available >= DISCORD_FRAME_BYTES:
                frame = bytes(self._buf[:DISCORD_FRAME_BYTES])
                del self._buf[:DISCORD_FRAME_BYTES]
                self.is_speaking = True
                return frame
            if available > 0:
                frame = bytes(self._buf) + (b"\x00" * (DISCORD_FRAME_BYTES - available))
                self._buf.clear()
                self.is_speaking = True
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
    """Runs Fish realtime transcription and speech inside a Discord voice channel."""

    def __init__(
        self,
        *,
        guild: discord.Guild,
        voice_channel: discord.VoiceChannel | discord.StageChannel,
        fish_api_key: str,
        reference_id: str,
        asr_model: str = "transcribe-stream-1",
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
        self._session_error: Exception | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._response_task: asyncio.Task[None] | None = None
        self._speech_task: asyncio.Task[None] | None = None
        self._last_speaker_id: int | None = None
        self._last_speaker_name = ""
        self._audio_sent_ms = 0
        self._audio_timeline: deque[tuple[int, int, int, str]] = deque()

    @property
    def is_connected(self) -> bool:
        return bool(self.voice_client and self.voice_client.is_connected() and not self._stop_event.is_set())

    def _push_pcm_from_thread(self, user_id: int, speaker_name: str, pcm_16k: bytes) -> None:
        if self._stop_event.is_set():
            return
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
            if HAS_VOICE_RECV and voice_recv is not None:
                self.voice_client = await self.voice_channel.connect(cls=voice_recv.VoiceRecvClient, self_deaf=False)
            else:
                self.voice_client = await self.voice_channel.connect(self_deaf=False)

            if not self.voice_client.is_playing():
                self.voice_client.play(
                    self.audio_source,
                    after=lambda err: print(f"[Capri voice playback error] {err}") if err else None,
                )

            if HAS_VOICE_RECV and hasattr(self.voice_client, "listen"):
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
                f"Timed out after {ASR_CONNECT_TIMEOUT_SECONDS} seconds waiting for Fish Audio "
                f"realtime transcription model `{self.asr_model}` to connect."
            ) from exc

        if self._session_error is not None:
            error = self._session_error
            await self.stop()
            raise RuntimeError(f"Fish Audio voice connection failed: {_exception_detail(error)}") from error
        if self._runner_task.done():
            await self.stop()
            raise RuntimeError("Fish Audio voice session ended during startup.")
        return HAS_VOICE_RECV

    async def say_text(self, text: str) -> None:
        clean = " ".join(str(text or "").split()).strip()
        if clean and not self._stop_event.is_set():
            await self._speech_queue.put(clean)

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
            async with websockets.connect(
                FISH_ASR_URL,
                additional_headers={
                    "Authorization": f"Bearer {self.fish_api_key}",
                    "model": self.asr_model,
                },
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                max_size=1_048_576,
            ) as websocket:
                await websocket.send(msgpack.packb({
                    "type": "config",
                    "audio": {"format": "pcm_s16le", "sample_rate": 16000, "channels": 1},
                    "turn_detection": {"mode": "auto", "eager": True},
                    "results": {"drafts": False, "diarize": False, "tag_audio_events": False},
                }, use_bin_type=True))

                while True:
                    message = self._unpack_asr_message(
                        await asyncio.wait_for(websocket.recv(), timeout=10)
                    )
                    if message.get("type") == "session_started":
                        break
                    if message.get("type") == "error":
                        raise RuntimeError(self._format_asr_error(message))

                self._ready_event.set()
                workers = [
                    asyncio.create_task(self._send_audio_loop(websocket)),
                    asyncio.create_task(self._receive_asr_loop(websocket)),
                    asyncio.create_task(self._respond_loop()),
                    asyncio.create_task(self._speak_loop()),
                    asyncio.create_task(self._stop_event.wait()),
                ]
                try:
                    done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
                    if not self._stop_event.is_set():
                        for task in done:
                            if task.cancelled():
                                continue
                            error = task.exception()
                            if error is not None:
                                self._session_error = error
                                print(f"[Capri Fish voice task error] {type(error).__name__}: {_exception_detail(error)}")
                                break
                        if self._session_error is None:
                            self._session_error = RuntimeError("Fish Audio voice session ended unexpectedly.")
                finally:
                    for task in workers:
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(*workers, return_exceptions=True)
        except asyncio.CancelledError:
            self._ready_event.set()
            raise
        except Exception as exc:
            self._session_error = exc
            self._ready_event.set()
            detail = _exception_detail(exc)
            print(f"[Capri Fish voice error] {type(exc).__name__}: {detail}")
            await self._notify_text_channel(f"Fish Audio voice session failed: `{detail}`")
        finally:
            await self.stop()

    @staticmethod
    def _unpack_asr_message(frame: Any) -> dict[str, Any]:
        if not isinstance(frame, (bytes, bytearray, memoryview)):
            raise RuntimeError("Fish Audio realtime ASR sent a non-binary frame.")
        message = msgpack.unpackb(frame, raw=False, strict_map_key=False)
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise RuntimeError("Fish Audio realtime ASR sent an invalid event.")
        return message

    @staticmethod
    def _format_asr_error(message: dict[str, Any]) -> str:
        error_type = message.get("error_type", "error")
        code = message.get("code", "unknown")
        detail = message.get("message", "no error message")
        request_id = message.get("request_id")
        suffix = f" [request {request_id}]" if request_id else ""
        return f"Fish ASR {error_type} ({code}): {detail}{suffix}"

    async def _send_audio_loop(self, websocket: Any) -> None:
        loop = asyncio.get_running_loop()
        next_send_at = loop.time()
        while not self._stop_event.is_set():
            delay = max(0.0, next_send_at - loop.time())
            try:
                if delay:
                    item = await asyncio.wait_for(self._audio_queue.get(), timeout=delay)
                else:
                    item = self._audio_queue.get_nowait()
            except (TimeoutError, asyncio.QueueEmpty):
                item = (
                    self._last_speaker_id or 0,
                    self._last_speaker_name or "Crew",
                    b"\x00" * 640,
                )
            else:
                if delay:
                    await asyncio.sleep(max(0.0, next_send_at - loop.time()))

            user_id, speaker_name, pcm_16k = item
            duration_seconds = max(len(pcm_16k) / 32000, 0.02)
            duration_ms = max(1, round(duration_seconds * 1000))
            start_ms = self._audio_sent_ms
            end_ms = start_ms + duration_ms
            self._audio_sent_ms = end_ms
            self._audio_timeline.append((start_ms, end_ms, user_id, speaker_name))
            while self._audio_timeline and self._audio_timeline[0][1] < end_ms - 60_000:
                self._audio_timeline.popleft()
            self._last_speaker_id = user_id
            self._last_speaker_name = speaker_name
            await websocket.send(msgpack.packb({"type": "audio", "data": pcm_16k}, use_bin_type=True))
            next_send_at = max(next_send_at + duration_seconds, loop.time() + duration_seconds)

    def _speaker_for_turn(self, message: dict[str, Any]) -> tuple[int, str]:
        start_ms = int(message.get("audio_start_ms", self._audio_sent_ms))
        end_ms = int(message.get("audio_end_ms", self._audio_sent_ms))
        scores: dict[tuple[int, str], int] = defaultdict(int)
        for segment_start, segment_end, user_id, speaker_name in self._audio_timeline:
            overlap = max(0, min(end_ms, segment_end) - max(start_ms, segment_start))
            if overlap:
                scores[(user_id, speaker_name)] += overlap
        if scores:
            return max(scores, key=scores.get)
        return self._last_speaker_id or 0, self._last_speaker_name or "Crew"

    async def _receive_asr_loop(self, websocket: Any) -> None:
        async for frame in websocket:
            message = self._unpack_asr_message(frame)
            event_type = message["type"]
            if event_type == "error":
                raise RuntimeError(self._format_asr_error(message))
            if event_type == "user_turn_taken":
                self._interrupt_speech()
            elif event_type == "committed" and message.get("user_turn", True):
                text = str(message.get("text") or "").strip()
                if text:
                    speaker_id, speaker_name = self._speaker_for_turn(message)
                    await self._turn_queue.put((speaker_id, speaker_name, text))
            elif event_type == "session_done" and not self._stop_event.is_set():
                raise RuntimeError("Fish Audio realtime transcription session ended.")
        if not self._stop_event.is_set():
            raise RuntimeError("Fish Audio realtime transcription connection closed.")

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
            task = asyncio.create_task(self._synthesize_speech(text))
            self._speech_task = task
            try:
                await task
            except asyncio.CancelledError:
                if self._stop_event.is_set():
                    raise
            except Exception as exc:
                detail = _exception_detail(exc)
                print(f"[Capri Fish TTS error] {type(exc).__name__}: {detail}")
                await self._notify_text_channel(f"Capri speech synthesis failed: `{detail}`")
            finally:
                if self._speech_task is task:
                    self._speech_task = None

    async def _synthesize_speech(self, text: str) -> None:
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
        asr_model: str = "transcribe-stream-1",
        tts_model: str = "s2.1-pro-free",
        vad_threshold: float = 110.0,
        text_channel: Any = None,
        on_transcript: Callable[[int, str, str, bool], Awaitable[None] | None] | None = None,
        on_user_turn: Callable[[int, str, str], Awaitable[str | None] | str | None] | None = None,
    ) -> tuple[CapriVoiceSession, bool]:
        if not fish_api_key:
            raise RuntimeError("Set FISH_AUDIO_API_KEY to enable Fish realtime voice and TTS.")
        if not reference_id:
            raise RuntimeError("Set FISH_AUDIO_REFERENCE_ID to choose Capri's Fish Audio voice.")

        existing = self._sessions.get(guild.id)
        if existing:
            if existing.is_connected and existing.voice_channel.id == voice_channel.id:
                return existing, HAS_VOICE_RECV
            await existing.stop()
            self._sessions.pop(guild.id, None)

        session = CapriVoiceSession(
            guild=guild,
            voice_channel=voice_channel,
            fish_api_key=fish_api_key,
            reference_id=reference_id,
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
