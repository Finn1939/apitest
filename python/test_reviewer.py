import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from capri_replies import SourceProblem, failure, load_acknowledgments, acknowledgment, receipt
from reviewer import collect_sources, send_reviewer, wants_reviewer


class StudyTests(unittest.IsolatedAsyncioTestCase):
    def test_routing(self):
        for request in ("Capri make a reviewer on SQL", "give me a .md file on art",
                        "study guide on recursion", "turn this PDF into notes"):
            self.assertTrue(wants_reviewer(request), request)
        for chat in ("my notes are missing", "create a channel called notes", "what's up?"):
            self.assertFalse(wants_reviewer(chat), chat)

    async def test_upload_order_and_bytes(self):
        events = []
        guide = "# Café\n\n## Key terms\n- café\n\n## Practice\nQ: What is café?\nA: Coffee."
        class Attachment:
            filename, size = "lecture.txt", 12
            async def read(self):
                events.append("read")
                return "aral".encode()
        class Upload:
            def __init__(self, fp, filename):
                self.fp, self.filename = fp, filename
            def close(self):
                self.fp.close()
        async def generate(system, payload, **kwargs):
            self.assertIn("voice marker", system)
            self.assertEqual(json.loads(payload)["sources"], ["aral"])
            events.append("generate")
            return "```markdown\n" + guide + "\n```"
        async def reply(line, file=None):
            events.append("upload" if file else "ack")
            if file:
                self.assertEqual(file.filename, "Café_reviewer.md")
                self.assertEqual(file.fp.read().decode(), guide + "\n")
        await send_reviewer(SimpleNamespace(content="make notes", channel=SimpleNamespace(typing=AsyncMock()), attachments=[Attachment()], reply=reply),
                            "voice marker", generate, Upload)
        self.assertEqual(events, ["ack", "read", "generate", "upload"])

    async def test_unusable_attachment_stops_generation(self):
        for ext, data in (("txt", b"\xff"), ("pdf", b"invalid"), ("docx", b"zip")):
            with self.assertRaises(SourceProblem):
                await collect_sources([SimpleNamespace(filename="notes." + ext, size=len(data), read=AsyncMock(return_value=data))])

    def test_local_fallbacks(self):
        error = RuntimeError("private upstream detail")
        for exc in (error, ValueError(str(error)), TimeoutError(str(error)), PermissionError(str(error))):
            self.assertNotIn("private", failure(exc))
        error.status = 429
        self.assertIn("brakes", failure(error))
        self.assertIn("stopped at step 2", receipt(["Created role Blue.", "Step 2 (role add) failed: Locked."]))

    def test_persona_ack_pool(self):
        persona = (Path(__file__).resolve().parents[1] / "personality.txt").read_text()
        load_acknowledgments(persona)
        for study in (True, False):
            self.assertIn(acknowledgment(study), persona)
