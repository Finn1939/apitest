import asyncio
import array
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dave_receive import _decrypt_packet, _install_dave_receive_patch, install_dave_receive_patch
from discord.ext.voice_recv.opus import PacketDecoder
from davey import MediaType
from voice_live import (
    CapriVoiceSession,
    DISCORD_FRAME_BYTES,
    VoiceAudioSource,
    VoiceSessionManager,
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


class TestGeminiVoiceConnection(unittest.IsolatedAsyncioTestCase):
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

        dave_session.ready = True
        connection.can_encrypt = True
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
                session._send_audio_loop = wait_for_stop
                session._receive_asr_loop = wait_for_stop
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

    async def test_asr_sender_sends_captured_audio_without_padding_idle_silence(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        pcm_frame = b"\x01\x00" * 320
        session._audio_queue.put_nowait((22, "Sam", pcm_frame))

        class FakeLiveSession:
            audio = None

            async def send_realtime_input(self, *, audio):
                self.audio = audio
                session._stop_event.set()

        live_session = FakeLiveSession()
        await session._send_audio_loop(live_session)
        self.assertEqual(live_session.audio.mime_type, "audio/pcm;rate=16000")
        self.assertEqual(live_session.audio.data, pcm_frame)
        self.assertEqual((session._last_speaker_id, session._last_speaker_name), (22, "Sam"))

    async def test_asr_sender_does_not_stream_silence_while_idle(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )

        class FakeLiveSession:
            sent_audio = False

            async def send_realtime_input(self, *, audio):
                self.sent_audio = True

        live_session = FakeLiveSession()
        sender = asyncio.create_task(session._send_audio_loop(live_session))
        await asyncio.sleep(0.02)
        self.assertFalse(live_session.sent_audio)
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)

    async def test_receiver_queues_final_transcript_with_latest_speaker(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        session._last_speaker_id = 22
        session._last_speaker_name = "Sam"

        class FakeLiveSession:
            async def receive(self):
                yield SimpleNamespace(server_content=SimpleNamespace(
                    input_transcription=SimpleNamespace(text="  Hello there.  ")
                ))
                session._stop_event.set()

        await session._receive_asr_loop(FakeLiveSession())
        self.assertEqual(await session._turn_queue.get(), (22, "Sam", "Hello there."))

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
        self.assertIn("mention Capri here", channel.messages[0])

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
        self.assertIn("Voice listening isn't available", channel.messages[0])
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
