"""用模拟时钟验证断网恢复逻辑，避免触发真实网络动作。"""

import unittest

from core import network_recovery as recovery


class NetworkRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.state = {}

    def check(self, second, status="missing_ipv4", boot="first", enabled=True, revision=""):
        return recovery.decide(self.state, status, second, boot, enabled, revision)

    def test_reconnect_then_reboot_only_after_five_hours(self):
        for minute in range(301):
            action = self.check(minute * 60)
            if minute == 300:
                self.assertEqual(action, "reboot")
            elif minute >= 5 and (minute - 5) % 15 == 0:
                self.assertEqual(action, "reconnect")
                self.state["reconnect_time"] = minute * 60
            else:
                self.assertIsNone(action)

        self.state["reboot_queued"] = True
        self.assertIsNone(self.check(301 * 60))
        self.assertIsNone(self.check(30, boot="next"))
        self.assertEqual(self.state["outage_start"], 30)

    def test_no_carrier_skips_reconnect_but_can_reboot(self):
        for minute in range(300):
            self.assertIsNone(self.check(minute * 60, status="no_carrier"))
        self.assertEqual(self.check(300 * 60, status="no_carrier"), "reboot")

    def test_recovery_unconfirmed_samples_and_sample_gaps_reset_outage(self):
        for status in ("online", "unknown"):
            self.check(0)
            self.check(60, status=status)
            self.assertNotIn("outage_start", self.state)
        self.check(120)
        self.assertIsNone(self.check(6 * 60 * 60))
        self.assertEqual(self.state["outage_start"], 6 * 60 * 60)

    def test_pausing_and_setting_changes_start_a_new_window(self):
        self.check(0)
        self.check(60, enabled=False)
        self.assertNotIn("outage_start", self.state)
        self.check(120, revision="enabled")
        self.check(180, revision="enabled-again")
        self.assertEqual(self.state["outage_start"], 180)


if __name__ == "__main__":
    unittest.main()
