import unittest
from types import SimpleNamespace

from actions_schema import (
    ACTIONS,
    DELETE_ACTIONS,
    format_action_outcome,
    format_channel_name,
    is_action_request,
    normalize_plan,
    requires_delete_confirmation,
    resolve_channel_from_list,
    resolve_role_from_list,
    should_check_authorized_action,
    validate_plan,
)


class TestPythonActionsSchema(unittest.TestCase):
    def test_full_crud_catalog(self):
        self.assertGreaterEqual(len(ACTIONS), 80)
        for key in ("channel_edit", "channel_rename", "channel_inspect", "role_add_all", "role_remove_all", "poll_send", "bot_presence_set", "members_prune"):
            self.assertIn(key, ACTIONS)

    def test_normalize_and_resolve_channel_and_role(self):
        normalized = normalize_plan(
            {"actions": [{"action": "channel_rename", "args": {"channel": "this channel", "newName": "Thalia Lounge"}}]},
            "1567358193334493247",
        )
        valid = validate_plan(normalized)
        self.assertEqual(valid["actions"][0]["action"], "channel_edit")
        self.assertEqual(valid["actions"][0]["args"]["channel"], "1567358193334493247")
        self.assertEqual(valid["actions"][0]["args"]["name"], "Thalia Lounge")
        self.assertFalse(requires_delete_confirmation(valid))

        recovered = normalize_plan(
            {"actions": [{"action": "channel_edit", "args": {"channel": "1567358193334493247"}}]},
            "1567358193334493247",
            "rename this channel to saitama",
        )
        self.assertEqual(validate_plan(recovered)["actions"][0]["args"]["name"], "saitama")

        bulk_role = normalize_plan(
            {"actions": [{"action": "role_add", "args": {"roleName": "coke", "target": "everyone"}}]},
            "1567358193334493247",
            "cpuld you add role coke to everyone",
        )
        valid_bulk = validate_plan(bulk_role)
        self.assertEqual(valid_bulk["actions"][0]["action"], "role_add_all")
        self.assertEqual(valid_bulk["actions"][0]["args"]["role"], "coke")
        self.assertEqual(valid_bulk["actions"][0]["args"]["targetGroup"], "everyone")
        self.assertFalse(requires_delete_confirmation(valid_bulk))

        with self.assertRaises(ValueError):
            validate_plan({"actions": [{"action": "channel_edit", "args": {"channel": "1567358193334493247"}}]})

        self.assertEqual(format_channel_name("Thalia Lounge", 0), "thalia-lounge")
        self.assertEqual(format_channel_name("Thalia Lounge", 2), "Thalia Lounge")

        chans = [
            SimpleNamespace(id=1567358193334493247, name="dog"),
            SimpleNamespace(id=999999999999999999, name="💬・general"),
        ]
        roles = [SimpleNamespace(id=555555555555555555, name="🥤・coke")]
        self.assertEqual(resolve_channel_from_list(chans, "general").id, 999999999999999999)
        self.assertEqual(resolve_channel_from_list(chans, "this", {"$current_channel": "1567358193334493247"}).id, 1567358193334493247)
        self.assertEqual(resolve_role_from_list(roles, "coke").id, 555555555555555555)

        self.assertIn("voice_join", ACTIONS)
        self.assertIn("voice_leave", ACTIONS)
        self.assertIn("voice_say", ACTIONS)

        vc_norm = normalize_plan(
            {"actions": [{"action": "voice_join", "args": {"channel": "vc"}}]},
            "1567358193334493247",
            "capri hop in vc",
        )
        vc_valid = validate_plan(vc_norm)
        self.assertEqual(vc_valid["actions"][0]["action"], "voice_join")
        self.assertNotIn("channel", vc_valid["actions"][0]["args"])
        self.assertFalse(requires_delete_confirmation(vc_valid))
        self.assertTrue(is_action_request("capri hop in vc", allow_unaddressed=False, is_named=True))

    def test_failure_detection_typo_tolerance_and_snowflake_reads(self):
        outcome = format_action_outcome(["Step 1 (channel_edit) failed: Discord rate-limited channel edits on #dog."])
        self.assertFalse(outcome["all_succeeded"])
        self.assertEqual(len(outcome["failures"]), 1)
        self.assertTrue(is_action_request("read 1567358193334493247", allow_unaddressed=True))
        self.assertTrue(should_check_authorized_action("cpuld you add role coke to everyone"))
        self.assertFalse(should_check_authorized_action("lol"))
        self.assertTrue(requires_delete_confirmation({"actions": [{"action": next(iter(DELETE_ACTIONS)), "args": {}}]}))


if __name__ == "__main__":
    unittest.main()
