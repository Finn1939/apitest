import struct
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from discord.gateway import DiscordVoiceWebSocket
from discord.voice_state import VoiceConnectionState

from davey_compat import install_davey_020_compat


class FakeDaveSession:
    def __init__(self, process_commit_result=True):
        self.process_commit_result = process_commit_result
        self.calls = []

    def process_commit(self, payload):
        self.calls.append(("commit", payload))
        return self.process_commit_result

    def process_welcome(self, payload):
        self.calls.append(("welcome", payload))

    def prepare_transition(self, transition_id, protocol_version):
        self.calls.append(("prepare", transition_id, protocol_version))

    def execute_transition(self, transition_id):
        self.calls.append(("execute", transition_id))


class TestDavey020Compat(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_received_message = DiscordVoiceWebSocket.received_message
        self.original_received_binary_message = DiscordVoiceWebSocket.received_binary_message
        self.original_execute_transition = VoiceConnectionState._execute_transition
        self.had_marker = hasattr(DiscordVoiceWebSocket, "_capri_davey_020_compat")
        self.old_marker = getattr(DiscordVoiceWebSocket, "_capri_davey_020_compat", None)
        install_davey_020_compat()

    def tearDown(self):
        DiscordVoiceWebSocket.received_message = self.original_received_message
        DiscordVoiceWebSocket.received_binary_message = self.original_received_binary_message
        VoiceConnectionState._execute_transition = self.original_execute_transition
        if self.had_marker:
            DiscordVoiceWebSocket._capri_davey_020_compat = self.old_marker
        else:
            del DiscordVoiceWebSocket._capri_davey_020_compat

    def make_socket(self, session, protocol_version=1):
        state = SimpleNamespace(
            dave_session=session,
            dave_protocol_version=protocol_version,
            dave_pending_transitions={},
            dave_downgraded=False,
            _recover_from_invalid_commit=AsyncMock(),
        )
        socket = SimpleNamespace(
            _connection=state,
            seq_ack=0,
            READY=DiscordVoiceWebSocket.READY,
            HEARTBEAT_ACK=DiscordVoiceWebSocket.HEARTBEAT_ACK,
            RESUMED=DiscordVoiceWebSocket.RESUMED,
            SESSION_DESCRIPTION=DiscordVoiceWebSocket.SESSION_DESCRIPTION,
            HELLO=DiscordVoiceWebSocket.HELLO,
            MLS_ANNOUNCE_COMMIT_TRANSITION=DiscordVoiceWebSocket.MLS_ANNOUNCE_COMMIT_TRANSITION,
            MLS_WELCOME=DiscordVoiceWebSocket.MLS_WELCOME,
            DAVE_PREPARE_TRANSITION=DiscordVoiceWebSocket.DAVE_PREPARE_TRANSITION,
            DAVE_EXECUTE_TRANSITION=DiscordVoiceWebSocket.DAVE_EXECUTE_TRANSITION,
            send_transition_ready=AsyncMock(),
            _hook=AsyncMock(),
        )
        return socket, state

    async def test_commit_prepares_initial_transition_without_ready_ack(self):
        session = FakeDaveSession()
        socket, _state = self.make_socket(session)
        message = struct.pack(">HBH", 7, socket.MLS_ANNOUNCE_COMMIT_TRANSITION, 0) + b"commit"

        await DiscordVoiceWebSocket.received_binary_message(socket, message)

        self.assertEqual(session.calls, [("commit", b"commit"), ("prepare", 0, 1)])
        socket.send_transition_ready.assert_not_awaited()

    async def test_commit_prepares_transition_before_ready_ack(self):
        session = FakeDaveSession()
        socket, state = self.make_socket(session)
        message = struct.pack(">HBH", 8, socket.MLS_ANNOUNCE_COMMIT_TRANSITION, 4) + b"commit"

        await DiscordVoiceWebSocket.received_binary_message(socket, message)

        self.assertEqual(session.calls, [("commit", b"commit"), ("prepare", 4, 1)])
        self.assertEqual(state.dave_pending_transitions, {4: 1})
        socket.send_transition_ready.assert_awaited_once_with(4)

    async def test_ignored_commit_does_not_prepare_or_acknowledge(self):
        session = FakeDaveSession(process_commit_result=False)
        socket, state = self.make_socket(session)
        message = struct.pack(">HBH", 9, socket.MLS_ANNOUNCE_COMMIT_TRANSITION, 4) + b"commit"

        await DiscordVoiceWebSocket.received_binary_message(socket, message)

        self.assertEqual(session.calls, [("commit", b"commit")])
        self.assertEqual(state.dave_pending_transitions, {})
        socket.send_transition_ready.assert_not_awaited()

    async def test_welcome_prepares_transition_before_ready_ack(self):
        session = FakeDaveSession()
        socket, state = self.make_socket(session)
        message = struct.pack(">HBH", 10, socket.MLS_WELCOME, 5) + b"welcome"

        await DiscordVoiceWebSocket.received_binary_message(socket, message)

        self.assertEqual(session.calls, [("welcome", b"welcome"), ("prepare", 5, 1)])
        self.assertEqual(state.dave_pending_transitions, {5: 1})
        socket.send_transition_ready.assert_awaited_once_with(5)

    async def test_prepare_transition_message_prepares_keys_before_ack(self):
        session = FakeDaveSession()
        socket, state = self.make_socket(session)
        message = {
            "op": socket.DAVE_PREPARE_TRANSITION,
            "d": {"transition_id": 6, "protocol_version": 1},
        }

        await DiscordVoiceWebSocket.received_message(socket, message)

        self.assertEqual(session.calls, [("prepare", 6, 1)])
        self.assertEqual(state.dave_pending_transitions, {6: 1})
        socket.send_transition_ready.assert_awaited_once_with(6)

    async def test_execute_transition_switches_dave_keys(self):
        session = FakeDaveSession()
        _socket, state = self.make_socket(session, protocol_version=0)
        state.dave_pending_transitions[7] = 1

        await VoiceConnectionState._execute_transition(state, 7)

        self.assertEqual(session.calls, [("execute", 7)])
        self.assertEqual(state.dave_protocol_version, 1)
    async def test_execute_initial_transition_does_not_execute_twice(self):
        session = FakeDaveSession()
        _socket, state = self.make_socket(session)
        state.dave_pending_transitions[0] = 1

        await VoiceConnectionState._execute_transition(state, 0)

        self.assertEqual(session.calls, [])
        self.assertEqual(state.dave_protocol_version, 1)
        self.assertEqual(state.dave_pending_transitions, {})
