import asyncio
import array
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dave_receive import _decrypt_packet, _install_dave_receive_patch, _process_packet, install_dave_receive_patch
from discord.opus import OpusError
from discord.ext.voice_recv.opus import PacketDecoder
from davey import MediaType
from voice_live import (
    CapriVoiceSession,
    DISCORD_FRAME_BYTES,
    VoiceAudioSource,
    VoiceSessionManager,
    _make_voice_sink,
    make_test_tone_48k_stereo,
    pcm_rms,
    pcm_rms_full,
    resample_24k_mono_to_48k_stereo,
    resample_48k_stereo_to_16k_mono,
)


def _to_le_bytes(samples: list[int]) -> bytes:
    arr = array.array("h", samples)
    if sys.byteorder == "big":
        arr.byteswap()
    return arr.tobytes()


def _from_le_bytes(raw: bytes) -> list[int]:
    arr = array.array("h")
    arr.frombytes(raw)
    if sys.byteorder == "big":
        arr.byteswap()
    return list(arr)


class TestVoiceAudio(unittest.TestCase):
    def test_resample_48k_stereo_to_16k_mono_ratios_and_averaging(self):
        # 20ms of Discord audio: 960 stereo frames * 4 bytes = 3840 bytes -> 320 mono samples * 2 bytes = 640 bytes
        stereo_samples: list[int] = []
        for _ in range(960):
            stereo_samples.extend([1200, 600])  # mono average = 900
        pcm_48k = _to_le_bytes(stereo_samples)
        self.assertEqual(len(pcm_48k), DISCORD_FRAME_BYTES)

        pcm_16k = resample_48k_stereo_to_16k_mono(pcm_48k)
        self.assertEqual(len(pcm_16k), 640)
        out_samples = _from_le_bytes(pcm_16k)
        self.assertEqual(len(out_samples), 320)
        self.assertTrue(all(s == 900 for s in out_samples))

    def test_resample_24k_mono_to_48k_stereo_interpolation(self):
        pcm_24k = _to_le_bytes([1000, 2000])
        pcm_48k, last_sample = resample_24k_mono_to_48k_stereo(pcm_24k, prev_sample=0)
        self.assertEqual(last_sample, 2000)
        self.assertEqual(len(pcm_48k), len(pcm_24k) * 4)
        self.assertEqual(_from_le_bytes(pcm_48k), [500, 500, 1000, 1000, 1500, 1500, 2000, 2000])

    def test_audio_source_frames_padding_and_barge_in_clear(self):
        src = VoiceAudioSource()
        # Empty buffer outputs pure 20ms silence frame (3840 bytes) without stopping playback
        silent = src.read()
        self.assertEqual(len(silent), DISCORD_FRAME_BYTES)
        self.assertEqual(silent, b"\x00" * DISCORD_FRAME_BYTES)
        self.assertFalse(src.is_speaking)

        # Enqueue 480 samples (20ms @ 24kHz mono = 960 bytes) -> expands to 3840 bytes (1 Discord frame)
        src.enqueue_24k_mono(_to_le_bytes([400] * 480))
        self.assertEqual(src.buffered_bytes(), DISCORD_FRAME_BYTES)
        spoken = src.read()
        self.assertEqual(len(spoken), DISCORD_FRAME_BYTES)
        self.assertTrue(src.is_speaking)
        self.assertEqual(src.buffered_bytes(), 0)
        self.assertEqual(src.audio_frames_read(), 1)
        self.assertEqual(src.audio_non_silent_frames_read(), 1)

        src.clear()
        src.enqueue_24k_mono(_to_le_bytes([0] * 480))
        src.read()
        self.assertEqual(src.audio_frames_read(), 2)
        self.assertEqual(src.audio_non_silent_frames_read(), 1)

        # Partial trailing chunk gets padded with zero silence to exact 3840 bytes
        src.enqueue_24k_mono(_to_le_bytes([500] * 100))
        padded = src.read()
        self.assertEqual(len(padded), DISCORD_FRAME_BYTES)
        self.assertEqual(src.audio_non_silent_frames_read(), 2)

        # Barge-in clear wipes queued audio immediately
        src.enqueue_24k_mono(_to_le_bytes([900] * 480))
        self.assertGreater(src.buffered_bytes(), 0)
        src.clear()
        self.assertEqual(src.buffered_bytes(), 0)
        self.assertFalse(src.is_speaking)

        # Cleanup stops Discord player by returning empty bytes
        src.cleanup()
        self.assertEqual(src.read(), b"")

    def test_pcm_rms_silence_vs_speech(self):
        self.assertEqual(pcm_rms(b"\x00" * 640), 0.0)
        self.assertGreater(pcm_rms(_to_le_bytes([2500, -2500] * 100)), 2000.0)

    def test_test_tone_duration_loudness_and_source_rms(self):
        tone = make_test_tone_48k_stereo()
        self.assertEqual(len(tone), 2 * 48000 * 4)
        tone_rms = pcm_rms_full(tone)
        self.assertGreater(tone_rms, 5700.0)
        self.assertLess(tone_rms, 5900.0)

        source = VoiceAudioSource()
        source.enqueue_48k_stereo(tone)
        frame = source.read()
        self.assertEqual(len(frame), DISCORD_FRAME_BYTES)
        self.assertGreater(source.last_audio_rms(), 5700.0)
        self.assertLess(source.last_audio_rms(), 5900.0)


class TestVoiceSink(unittest.TestCase):
    def test_input_stats_distinguish_vad_from_forwarded_audio(self):
        loop = asyncio.new_event_loop()
        forwarded = []
        try:
            sink = _make_voice_sink(loop, lambda *args: forwarded.append(args), 110)
            user = SimpleNamespace(id=42, bot=False, display_name="Test")
            data = SimpleNamespace(pcm=b"decoded")
            with patch("voice_live.resample_48k_stereo_to_16k_mono", return_value=b"pcm"):
                with patch("voice_live.pcm_rms", side_effect=[120.0, 50.0]):
                    sink.write(user, data)
                    sink.write(user, data)
            loop.run_until_complete(asyncio.sleep(0))
            self.assertEqual(sink.input_stats(), (2, 1, 2, 50.0))
            self.assertEqual(len(forwarded), 2)
        finally:
            loop.close()


class TestGeminiVoiceConnection(unittest.IsolatedAsyncioTestCase):
    async def test_response_worker_processes_call_turns_sequentially(self):
        started = []
        active = 0
        max_active = 0
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        second_finished = asyncio.Event()

        async def answer(_speaker_id, _speaker_name, text):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            started.append(text)
            if text == "first":
                first_started.set()
                await release_first.wait()
            active -= 1
            if text == "second":
                second_finished.set()

        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
            on_user_turn=answer,
        )
        session._chat_queue.put_nowait((1, "Kei", "first"))
        session._chat_queue.put_nowait((1, "Kei", "second"))
        worker = asyncio.create_task(session._respond_loop())
        try:
            await asyncio.wait_for(first_started.wait(), timeout=1)
            await asyncio.sleep(0)
            self.assertEqual(started, ["first"])
            release_first.set()
            await asyncio.wait_for(second_finished.wait(), timeout=1)
            self.assertEqual(started, ["first", "second"])
            self.assertEqual(max_active, 1)
        finally:
            session._stop_event.set()
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    async def test_tts_audio_is_not_limited_by_a_local_buffer_cap(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        session.audio_source.enqueue_24k_mono(b"\x00" * 4)

        await session._enqueue_tts_audio(b"\x01\x00")
        self.assertEqual(session.audio_source.buffered_bytes(), 24)

    async def test_dave_state_blocks_audio_until_encryption_is_available(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        dave_session = SimpleNamespace(ready=False)
        connection = SimpleNamespace(
            dave_protocol_version=1,
            dave_session=dave_session,
            can_encrypt=False,
        )
        session.voice_client = SimpleNamespace(_connection=connection)

        self.assertEqual(session.dave_state(), (1, False, False))
        self.assertTrue(session.dave_blocking_audio())
        self.assertFalse(await session.wait_for_dave(timeout=0))

        connection.can_encrypt = True
        self.assertTrue(session.dave_blocking_audio())
        dave_session.ready = True
        self.assertEqual(session.dave_state(), (1, True, True))
        self.assertFalse(session.dave_blocking_audio())
        self.assertTrue(await session.wait_for_dave(timeout=0))

    async def test_dave_wait_stops_when_session_is_stopping(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        session.voice_client = SimpleNamespace(
            _connection=SimpleNamespace(
                dave_protocol_version=1,
                dave_session=SimpleNamespace(ready=False),
                can_encrypt=False,
            )
        )
        session._stop_event.set()

        self.assertFalse(await session.wait_for_dave())

    async def test_playback_error_restarts_player_after_dave_is_ready(self):
        started = asyncio.Event()

        class FakeVoiceClient:
            playing = False

            def __init__(self):
                self._connection = SimpleNamespace(
                    dave_protocol_version=1,
                    dave_session=SimpleNamespace(ready=True),
                    can_encrypt=True,
                )

            def is_connected(self):
                return True

            def is_playing(self):
                return self.playing

            def play(self, _source, after=None):
                self.playing = True
                started.set()

        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        session.voice_client = FakeVoiceClient()
        session._loop = asyncio.get_running_loop()
        original_source = session.audio_source

        session._record_playback_error(ValueError("Failed to encrypt: NotReady"))
        await asyncio.wait_for(started.wait(), timeout=1)

        self.assertTrue(session.voice_client.is_playing())
        self.assertIsNot(session.audio_source, original_source)
        self.assertEqual(session._playback_errors, 1)

        session._stop_event.set()

    async def test_speak_loop_posts_text_when_dave_never_becomes_ready(self):
        class FakeTextChannel:
            messages = []

            async def send(self, message, *, allowed_mentions):
                self.messages.append(message)
                session._stop_event.set()

        channel = FakeTextChannel()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
            text_channel=channel,
        )

        async def dave_stays_unready():
            return False

        async def synthesis_must_not_run(_text):
            raise AssertionError("TTS must not run while DAVE cannot encrypt")

        session.wait_for_dave = dave_stays_unready
        session._synthesize_speech = synthesis_must_not_run
        session._speech_queue.put_nowait("Here is the reply.")
        await session._speak_loop()

        self.assertIn("Here is the reply.", channel.messages[0])
        self.assertIn("DAVE E2EE not ready", session._last_tts_error)

    async def test_tts_only_session_works_without_gemini_or_voice_receiver(self):
        class FakeVoiceClient:
            connected = True
            playing = False

            def is_playing(self):
                return self.playing

            def play(self, _source, after=None):
                self.playing = True

            def stop(self):
                self.playing = False

            def is_connected(self):
                return self.connected

            async def disconnect(self, force=False):
                self.connected = False

        class FakeVoiceChannel:
            def __init__(self):
                self.connect_kwargs = None

            async def connect(self, **kwargs):
                self.connect_kwargs = kwargs
                return voice_client

        voice_client = FakeVoiceClient()
        voice_channel = FakeVoiceChannel()
        manager = VoiceSessionManager()
        session, listen_enabled = await manager.join(
            guild=SimpleNamespace(id=1),
            voice_channel=voice_channel,
            fish_api_key="test-key",
            reference_id="test-voice",
            enable_asr=False,
        )
        spoken = asyncio.Event()
        synthesized = []

        async def synthesize(text):
            synthesized.append(text)
            spoken.set()
            return 1200

        session._synthesize_speech = synthesize
        with patch("voice_live.HAS_VOICE_RECV", True):
            self.assertFalse(listen_enabled)
            self.assertEqual(voice_channel.connect_kwargs, {"self_deaf": False})
            self.assertTrue(session.is_connected)
            self.assertTrue(await manager.say(1, "Hello over voice"))
            await asyncio.wait_for(spoken.wait(), timeout=1)
            await manager.leave(1)

        self.assertEqual(synthesized, ["Hello over voice"])
        self.assertFalse(voice_client.connected)

    async def test_input_watchdog_completion_does_not_stop_voice_workers(self):
        for receive_audio in (False, True):
            with self.subTest(receive_audio=receive_audio):
                session = CapriVoiceSession(
                    guild=SimpleNamespace(id=1),
                    voice_channel=SimpleNamespace(),
                    fish_api_key="test-key",
                    reference_id="test-voice",
                )
                watchdog_finished = asyncio.Event()
                run_watchdog = session._watch_initial_voice_input

                async def tracked_watchdog():
                    await run_watchdog()
                    watchdog_finished.set()

                async def wait_for_stop(*_args):
                    await session._stop_event.wait()

                session._watch_initial_voice_input = tracked_watchdog
                session._listen_to_speakers = wait_for_stop
                session._respond_loop = wait_for_stop
                session._speak_loop = wait_for_stop
                if receive_audio:
                    session._audio_received_event.set()

                timeout = 30 if receive_audio else 0
                with patch("voice_live.VOICE_INPUT_TIMEOUT_SECONDS", timeout):
                    runner = asyncio.create_task(session._run_voice_workers(object()))
                    await asyncio.wait_for(watchdog_finished.wait(), timeout=1)
                    await asyncio.sleep(0)
                    self.assertFalse(runner.done())
                    await session.stop()
                    await asyncio.wait_for(runner, timeout=1)

    async def test_start_disconnects_and_reports_empty_voice_setup_error(self):
        class FakeVoiceClient:
            connected = True

            def is_playing(self):
                return False

            def play(self, _source, after=None):
                pass

            def listen(self, _sink):
                raise RuntimeError()

            def is_connected(self):
                return self.connected

            async def disconnect(self, force=False):
                self.connected = False

        class FakeVoiceChannel:
            async def connect(self, **_kwargs):
                return voice_client

        voice_client = FakeVoiceClient()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=FakeVoiceChannel(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        fake_voice_recv = SimpleNamespace(VoiceRecvClient=object)
        with (
            patch("voice_live.HAS_VOICE_RECV", True),
            patch("voice_live.voice_recv", fake_voice_recv),
            patch("voice_live._make_voice_sink", return_value=object()),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"Discord voice setup failed \(RuntimeError\): RuntimeError\(\)",
            ):
                await session.start()
        self.assertFalse(voice_client.connected)

    async def test_start_waits_for_dave_encryption_before_starting_audio(self):
        class FakeVoiceClient:
            connected = True

            def __init__(self):
                self._connection = SimpleNamespace(
                    dave_protocol_version=1,
                    dave_session=SimpleNamespace(ready=False),
                    can_encrypt=False,
                )
                self.play_started_with_encryption = []

            def is_playing(self):
                return False

            def play(self, _source, after=None):
                self.play_started_with_encryption.append(self._connection.can_encrypt)

            def is_connected(self):
                return self.connected

            def stop(self):
                pass

            async def disconnect(self, force=False):
                self.connected = False

        voice_client = FakeVoiceClient()

        class FakeVoiceChannel:
            async def connect(self, **_kwargs):
                async def complete_dave_handshake():
                    await asyncio.sleep(0.01)
                    voice_client._connection.dave_session.ready = True
                    voice_client._connection.can_encrypt = True

                asyncio.create_task(complete_dave_handshake())
                return voice_client

        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=FakeVoiceChannel(),
            fish_api_key="test-key",
            reference_id="test-voice",
            enable_asr=False,
        )
        await session.start()
        try:
            self.assertEqual(voice_client.play_started_with_encryption, [True])
        finally:
            await session.stop()

    async def test_start_aborts_without_playing_if_dave_never_becomes_ready(self):
        class FakeVoiceClient:
            connected = True

            def __init__(self):
                self._connection = SimpleNamespace(
                    dave_protocol_version=1,
                    dave_session=SimpleNamespace(ready=False),
                    can_encrypt=False,
                )
                self.play_called = False

            def is_playing(self):
                return False

            def play(self, _source, after=None):
                self.play_called = True

            def is_connected(self):
                return self.connected

            async def disconnect(self, force=False):
                self.connected = False

        voice_client = FakeVoiceClient()

        class FakeVoiceChannel:
            async def connect(self, **_kwargs):
                return voice_client

        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=FakeVoiceChannel(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )

        async def dave_stays_unready():
            return False

        session.wait_for_dave = dave_stays_unready
        with self.assertRaisesRegex(RuntimeError, "DAVE voice encryption did not become ready"):
            await session.start()

        self.assertFalse(voice_client.play_called)
        self.assertFalse(voice_client.connected)

    async def test_start_surfaces_gemini_asr_error_and_disconnects(self):
        class FakeVoiceClient:
            connected = True

            def is_playing(self):
                return False

            def play(self, _source, after=None):
                pass

            def listen(self, _sink):
                pass

            def is_connected(self):
                return self.connected

            async def disconnect(self, force=False):
                self.connected = False

        class FakeVoiceChannel:
            async def connect(self, **_kwargs):
                return voice_client

        class FailedASRConnection:
            async def __aenter__(self):
                raise RuntimeError("invalid test key")

            async def __aexit__(self, *_args):
                return False

        class FakeLiveAPI:
            def connect(self, *, model, config):
                self.model = model
                self.config = config
                return connection

        voice_client = FakeVoiceClient()
        live_api = FakeLiveAPI()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=FakeVoiceChannel(),
            fish_api_key="test-key",
            reference_id="test-voice",
            gemini_client=SimpleNamespace(aio=SimpleNamespace(live=live_api)),
        )
        connection = FailedASRConnection()
        fake_voice_recv = SimpleNamespace(VoiceRecvClient=object)
        with (
            patch("voice_live.HAS_VOICE_RECV", True),
            patch("voice_live.voice_recv", fake_voice_recv),
            patch("voice_live._make_voice_sink", return_value=object()),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"Gemini Live ASR connection failed: invalid test key",
            ):
                await session.start()
        self.assertFalse(voice_client.connected)
        self.assertEqual(live_api.model, "gemini-3.5-transcribe-live")
        self.assertEqual(live_api.config["response_modalities"], ["TEXT"])
        self.assertEqual(live_api.config["input_audio_transcription"]["language_codes"], [])

    async def test_tts_stream_uses_selected_voice_and_feeds_pcm_audio(self):
        class FakeContent:
            async def iter_chunked(self, _chunk_size):
                yield b"\x01"
                yield b"\x00\x02\x00"

        class FakeResponse:
            status = 200
            content = FakeContent()

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

        class FakeHttpSession:
            def __init__(self, *, timeout):
                self.request = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def close(self):
                pass

            def post(self, url, *, headers, json):
                self.request = (url, headers, json)
                requests.append(self.request)
                return FakeResponse()

        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="chosen-fish-voice",
        )
        requests = []
        with patch("voice_live.aiohttp.ClientSession", FakeHttpSession):
            audio_bytes = await session._synthesize_speech("Hello there.")
        self.assertEqual(audio_bytes, 4)
        self.assertEqual(requests[0][0], "https://api.fish.audio/v1/tts")
        self.assertEqual(requests[0][2]["reference_id"], "chosen-fish-voice")
        self.assertEqual(requests[0][2]["format"], "pcm")
        self.assertEqual(requests[0][2]["sample_rate"], 24000)
        self.assertEqual(session.audio_source.buffered_bytes(), 16)
        await session.stop()

    async def test_no_voice_input_prompts_text_chat_fallback(self):
        class FakeTextChannel:
            messages = []

            async def send(self, message, *, allowed_mentions):
                self.messages.append(message)

        channel = FakeTextChannel()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
            text_channel=channel,
        )
        with patch("voice_live.VOICE_INPUT_TIMEOUT_SECONDS", 0):
            await session._watch_initial_voice_input()
        self.assertIn("ping me here", channel.messages[0])

    async def test_missing_voice_receiver_keeps_text_and_speech_workers_available(self):
        class FakeTextChannel:
            def __init__(self):
                self.messages = []
                self.notified = asyncio.Event()

            async def send(self, message, *, allowed_mentions):
                self.messages.append(message)
                self.notified.set()

        class FakeLiveAPI:
            def connect(self, **_kwargs):
                raise AssertionError("Gemini must not be opened without voice input")

        channel = FakeTextChannel()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
            gemini_client=SimpleNamespace(aio=SimpleNamespace(live=FakeLiveAPI())),
            text_channel=channel,
        )
        runner = asyncio.create_task(session._run_session_loop())
        await asyncio.wait_for(channel.notified.wait(), timeout=1)
        self.assertIn("My mic feed’s quiet", channel.messages[0])
        await session.stop()
        await runner

    async def test_tts_failure_posts_text_fallback(self):
        class FakeTextChannel:
            messages = []

            async def send(self, message, *, allowed_mentions):
                self.messages.append(message)
                session._stop_event.set()

        channel = FakeTextChannel()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
            text_channel=channel,
        )

        async def fail_synthesis(_text):
            raise RuntimeError("TTS unavailable")

        session._synthesize_speech = fail_synthesis
        session._speech_queue.put_nowait("Here is the reply.")
        await session._speak_loop()
        self.assertIn("Here is the reply.", channel.messages[0])


class TestDaveReceive(unittest.TestCase):
    def _decoder(self, session, user_id=123):
        class FakeVoiceClient:
            _connection = SimpleNamespace(dave_protocol_version=1, dave_session=session)

            def _get_id_from_ssrc(self, _ssrc):
                return user_id

        packet = SimpleNamespace(
            decrypted_data=b"encrypted",
            sequence=7,
            timestamp=42,
            is_silence=lambda: False,
        )
        decoder = SimpleNamespace(
            sink=SimpleNamespace(voice_client=FakeVoiceClient()),
            ssrc=17,
            _cached_id=None,
            _last_seq=0,
            _last_ts=0,
        )
        return decoder, packet

    def test_decrypts_ready_dave_audio_before_opus_processing(self):
        class FakeDaveSession:
            ready = True

            def set_passthrough_mode(self, enabled, expiry):
                self.passthrough = (enabled, expiry)

            def decrypt(self, user_id, media_type, packet):
                self.request = (user_id, media_type, packet)
                return b"opus"

        session = FakeDaveSession()
        decoder, packet = self._decoder(session)

        self.assertTrue(_decrypt_packet(decoder, packet))
        self.assertEqual(packet.decrypted_data, b"opus")
        self.assertEqual(session.request, (123, MediaType.audio, b"encrypted"))
        self.assertEqual(session.passthrough, (True, 10))

    def test_drops_packet_if_dave_session_is_not_ready(self):
        session = SimpleNamespace(ready=False)
        decoder, packet = self._decoder(session)

        with self.assertLogs("dave_receive", level="WARNING"):
            self.assertFalse(_decrypt_packet(decoder, packet))
        self.assertEqual((decoder._last_seq, decoder._last_ts), (7, 42))
        self.assertEqual(packet.decrypted_data, b"encrypted")

    def test_corrupt_opus_packet_does_not_stop_receive_processing(self):
        class FakeDaveSession:
            ready = True

            def set_passthrough_mode(self, enabled, expiry):
                pass

            def decrypt(self, _user_id, _media_type, _packet):
                return b"opus"

        class CorruptedOpusError(OpusError):
            def __init__(self):
                Exception.__init__(self, "corrupted stream")

        decoder, packet = self._decoder(FakeDaveSession())

        def decode(_decoder, _packet):
            raise CorruptedOpusError()

        with self.assertLogs("dave_receive", level="WARNING"):
            self.assertIsNone(_process_packet(decoder, packet, decode))
        self.assertEqual((decoder._last_seq, decoder._last_ts), (7, 42))

    def test_installed_packet_decoder_hook_drops_unready_dave_packets(self):
        _install_dave_receive_patch()
        decoder, packet = self._decoder(SimpleNamespace(ready=False))

        with self.assertLogs("dave_receive", level="WARNING"):
            self.assertIsNone(PacketDecoder._process_packet(decoder, packet))

    def test_native_dave_receiver_does_not_get_decrypted_twice(self):
        with patch.object(PacketDecoder, "_process_packet") as native_processor:
            with patch("dave_receive.voice_recv.__version__", "0.5.4a"):
                install_dave_receive_patch()

            self.assertIs(PacketDecoder._process_packet, native_processor)


if __name__ == "__main__":
    unittest.main()
