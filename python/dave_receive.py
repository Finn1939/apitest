import logging
import re
import time
from typing import Any

from davey import MediaType
from discord.opus import OpusError
from discord.ext import voice_recv
from discord.ext.voice_recv.opus import PacketDecoder

_log = logging.getLogger(__name__)


def _drop_packet(decoder: Any, packet: Any, reason: str) -> bool:
    decoder._last_seq = packet.sequence
    decoder._last_ts = packet.timestamp
    failures = getattr(decoder, "_capri_dave_failures", 0) + 1
    decoder._capri_dave_failures = failures
    now = time.monotonic()
    last_log = getattr(decoder, "_capri_dave_last_log", 0.0)
    if now - last_log >= 10:
        _log.warning(
            "Dropping voice packets for SSRC %s (%s since last report): %s",
            decoder.ssrc,
            failures,
            reason,
        )
        decoder._capri_dave_failures = 0
        decoder._capri_dave_last_log = now
    return False


def _decrypt_packet(decoder: Any, packet: Any) -> bool:
    if not packet or packet.is_silence():
        return True

    voice_client = decoder.sink.voice_client
    connection = voice_client._connection
    if not getattr(connection, "dave_protocol_version", 0):
        return True

    dave_session = getattr(connection, "dave_session", None)
    if dave_session is None or not dave_session.ready:
        return _drop_packet(decoder, packet, "DAVE session is not ready")

    user_id = decoder._cached_id
    if user_id is None:
        user_id = voice_client._get_id_from_ssrc(decoder.ssrc)
    if user_id is None:
        return _drop_packet(decoder, packet, "speaker ID is not mapped to this SSRC")

    try:
        if getattr(decoder, "_capri_dave_session", None) is not dave_session:
            dave_session.set_passthrough_mode(True, 10)
            decoder._capri_dave_session = dave_session
        packet.decrypted_data = dave_session.decrypt(
            int(user_id), MediaType.audio, bytes(packet.decrypted_data)
        )
    except Exception as exc:
        return _drop_packet(
            decoder,
            packet,
            f"{type(exc).__name__}: {str(exc).strip() or repr(exc)}",
        )
    return True


def _process_packet(decoder: Any, packet: Any, original: Any) -> Any:
    if not _decrypt_packet(decoder, packet):
        return None

    try:
        return original(decoder, packet)
    except OpusError as exc:
        _drop_packet(decoder, packet, f"Opus decoder rejected packet: {exc}")
        return None


def install_dave_receive_patch() -> None:
    version = getattr(voice_recv, "__version__", "")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
    if match and tuple(map(int, match.groups())) >= (0, 5, 4):
        return

    _install_dave_receive_patch()


def _install_dave_receive_patch() -> None:
    current = PacketDecoder._process_packet
    if getattr(current, "_capri_dave_aware", False):
        return

    original = current

    def process_packet(decoder: Any, packet: Any) -> Any:
        return _process_packet(decoder, packet, original)

    setattr(process_packet, "_capri_dave_aware", True)
    PacketDecoder._process_packet = process_packet
