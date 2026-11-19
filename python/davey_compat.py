"""Adapt discord.py's voice gateway to davey 0.2's explicit transition API."""

import logging
import struct
from typing import Any

from discord.gateway import DiscordVoiceWebSocket
from discord.voice_state import VoiceConnectionState


_log = logging.getLogger("discord.gateway")


def _process_commit(
    session: Any,
    commit: bytes,
    transition_id: int,
    protocol_version: int,
) -> bool:
    if not session.process_commit(commit):
        return False
    session.prepare_transition(transition_id, protocol_version)
    return True


def _process_welcome(
    session: Any,
    welcome: bytes,
    transition_id: int,
    protocol_version: int,
) -> None:
    session.process_welcome(welcome)
    session.prepare_transition(transition_id, protocol_version)


def install_davey_020_compat() -> None:
    if getattr(DiscordVoiceWebSocket, "_capri_davey_020_compat", False):
        return

    original_received_message = DiscordVoiceWebSocket.received_message
    original_received_binary_message = DiscordVoiceWebSocket.received_binary_message
    original_execute_transition = VoiceConnectionState._execute_transition

    async def received_message(self: Any, msg: dict[str, Any]) -> None:
        if msg.get("op") == self.DAVE_PREPARE_TRANSITION:
            session = self._connection.dave_session
            if session is not None:
                data = msg["d"]
                session.prepare_transition(data["transition_id"], data["protocol_version"])
        await original_received_message(self, msg)

    async def received_binary_message(self: Any, msg: bytes) -> None:
        op = msg[2] if len(msg) > 2 else None
        if op not in (
            self.MLS_ANNOUNCE_COMMIT_TRANSITION,
            self.MLS_WELCOME,
        ):
            await original_received_binary_message(self, msg)
            return

        self.seq_ack = struct.unpack_from(">H", msg, 0)[0]
        _log.debug("Voice websocket binary frame received: %d bytes; seq=%s op=%s", len(msg), self.seq_ack, op)
        state = self._connection
        session = state.dave_session
        if session is None:
            return

        transition_id = struct.unpack_from(">H", msg, 3)[0]
        try:
            if op == self.MLS_ANNOUNCE_COMMIT_TRANSITION:
                prepared = _process_commit(
                    session,
                    msg[5:],
                    transition_id,
                    state.dave_protocol_version,
                )
                if not prepared:
                    _log.debug("Ignoring DAVE commit without a pending transition")
                    return
                _log.debug("MLS commit processed for transition id %d", transition_id)
            else:
                _process_welcome(
                    session,
                    msg[5:],
                    transition_id,
                    state.dave_protocol_version,
                )
                _log.debug("MLS welcome processed for transition id %d", transition_id)

            if transition_id != 0:
                state.dave_pending_transitions[transition_id] = state.dave_protocol_version
                await self.send_transition_ready(transition_id)
        except Exception:
            _log.exception("Failed to process DAVE MLS transition %d", transition_id)
            await state._recover_from_invalid_commit(transition_id)

    async def execute_transition(self: Any, transition_id: int) -> None:
        if transition_id != 0 and transition_id in self.dave_pending_transitions and self.dave_session:
            self.dave_session.execute_transition(transition_id)
        await original_execute_transition(self, transition_id)

    DiscordVoiceWebSocket.received_message = received_message
    DiscordVoiceWebSocket.received_binary_message = received_binary_message
    VoiceConnectionState._execute_transition = execute_transition
    DiscordVoiceWebSocket._capri_davey_020_compat = True
