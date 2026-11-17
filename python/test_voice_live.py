import array
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import msgpack

from voice_live import (
    CapriVoiceSession,
    DISCORD_FRAME_BYTES,
    VoiceAudioSource,
    pcm_rms,
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

        # Partial trailing chunk gets padded with zero silence to exact 3840 bytes
        src.enqueue_24k_mono(_to_le_bytes([500] * 100))
        padded = src.read()
        self.assertEqual(len(padded), DISCORD_FRAME_BYTES)

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


class TestFishVoiceConnection(unittest.IsolatedAsyncioTestCase):
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

    async def test_start_surfaces_fish_asr_error_and_disconnects(self):
        class FakeVoiceClient:
            connected = True

            def is_playing(self):
                return False

            def play(self, _source, after=None):
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
                return self

            async def send(self, frame):
                self.config = msgpack.unpackb(frame, raw=False)

            async def recv(self):
                return msgpack.packb({
                    "type": "error",
                    "error_type": "unauthorized",
                    "code": 401,
                    "message": "invalid test key",
                }, use_bin_type=True)

            async def __aexit__(self, *_args):
                return False

        voice_client = FakeVoiceClient()
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=FakeVoiceChannel(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        connection = FailedASRConnection()
        with (
            patch("voice_live.HAS_VOICE_RECV", False),
            patch("voice_live.websockets.connect", return_value=connection),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                r"Fish Audio voice connection failed: Fish ASR unauthorized \(401\): invalid test key",
            ):
                await session.start()
        self.assertFalse(voice_client.connected)
        self.assertEqual(connection.config["audio"], {
            "format": "pcm_s16le",
            "sample_rate": 16000,
            "channels": 1,
        })

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
            await session._synthesize_speech("Hello there.")
        self.assertEqual(requests[0][0], "https://api.fish.audio/v1/tts")
        self.assertEqual(requests[0][2]["reference_id"], "chosen-fish-voice")
        self.assertEqual(requests[0][2]["format"], "pcm")
        self.assertEqual(requests[0][2]["sample_rate"], 24000)
        self.assertEqual(session.audio_source.buffered_bytes(), 16)

    def test_speaker_attribution_uses_asr_turn_timestamps(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )
        session._audio_timeline.extend([
            (0, 1000, 11, "Alex"),
            (1000, 2000, 22, "Sam"),
        ])
        self.assertEqual(
            session._speaker_for_turn({"audio_start_ms": 1100, "audio_end_ms": 1900}),
            (22, "Sam"),
        )

    async def test_asr_sender_keeps_idle_silence_for_turn_detection(self):
        session = CapriVoiceSession(
            guild=SimpleNamespace(id=1),
            voice_channel=SimpleNamespace(),
            fish_api_key="test-key",
            reference_id="test-voice",
        )

        class FakeWebSocket:
            frame = None

            async def send(self, frame):
                self.frame = msgpack.unpackb(frame, raw=False)
                session._stop_event.set()

        websocket = FakeWebSocket()
        await session._send_audio_loop(websocket)
        self.assertEqual(websocket.frame["type"], "audio")
        self.assertEqual(websocket.frame["data"], b"\x00" * 640)


if __name__ == "__main__":
    unittest.main()
