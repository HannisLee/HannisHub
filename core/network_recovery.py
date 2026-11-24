"""定期检查主网卡，由本机 systemd 执行网络恢复。"""

import json
import os
import pwd
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SETTINGS_SECTION = "network_recovery"
RECONNECT_AFTER = 5 * 60
REBOOT_AFTER = 5 * 60 * 60
RECONNECT_INTERVAL = 15 * 60
MAX_SAMPLE_GAP = 3 * 60
AUTHORIZATION = Path("/etc/hannishub-network/authorized")
RECONNECT = ("/usr/bin/systemctl", "--system", "start", "hannishub-network-reconnect.service")
REBOOT = ("/usr/bin/systemctl", "--system", "--no-block", "reboot")


def state_path() -> Path:
    return Path.home() / ".local/state/hannishub-network/status.json"


def read_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def run(*args: str, timeout: int = 5) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def ip_data(*args: str) -> list:
    result = run("/usr/bin/ip", "-j", *args)
    if result.returncode:
        raise OSError("ip 查询失败")
    return json.loads(result.stdout)


def inspect_link(interface: str) -> dict:
    sample = {"link": False, "address": None, "gateway": None, "connectivity": "unknown"}
    # NetworkManager 的外网探测结果仅用于诊断，读取失败不影响本机巡检。
    try:
        result = run("/usr/bin/nmcli", "-t", "networking", "connectivity")
        if result.returncode == 0:
            sample["connectivity"] = result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        links = ip_data("link", "show", "dev", interface)
        sample["link"] = "LOWER_UP" in links[0]["flags"]
        if not sample["link"]:
            return {**sample, "status": "no_carrier"}
        addresses = ip_data("-4", "addr", "show", "dev", interface, "scope", "global")
        for address in addresses[0]["addr_info"]:
            if address.get("preferred_life_time") != 0 and not address["local"].startswith("169.254."):
                sample["address"] = address["local"]
                break
        routes = ip_data("-4", "route", "show", "default", "dev", interface)
        sample["gateway"] = next((route["gateway"] for route in routes if "gateway" in route), None)
        if not sample["address"] or not sample["gateway"]:
            return {**sample, "status": "missing_ipv4" if not sample["address"] else "missing_route"}
        gateway = sample["gateway"]
        ping = run("/usr/bin/ping", "-n", "-c", "1", "-W", "4", "-I", interface, gateway, timeout=6)
        if ping.returncode == 0:
            return {**sample, "status": "online"}
        # 网关可能禁止 ICMP。只有邻居解析明确失败时才判定本地网络故障。
        neighbors = ip_data("-4", "neigh", "show", "to", gateway, "dev", interface)
        if any("FAILED" in neighbor.get("state", ()) for neighbor in neighbors):
            return {**sample, "status": "gateway_unreachable"}
        if any(neighbor.get("lladdr") for neighbor in neighbors):
            return {**sample, "status": "online"}
    except (OSError, ValueError, KeyError, IndexError, subprocess.TimeoutExpired):
        pass
    return {**sample, "status": "unknown"}


def decide(state: dict, status: str, now: float, boot: str, enabled: bool, revision: str) -> str | None:
    previous_time = state.get("sample_time")
    if (
        state.get("boot") != boot
        or state.get("revision") != revision
        or not isinstance(previous_time, (int, float))
        or not 0 <= now - previous_time <= MAX_SAMPLE_GAP
    ):
        state.pop("outage_start", None)
        state.pop("reconnect_time", None)
        if state.get("boot") != boot:
            state.pop("reboot_queued", None)
    state.update(boot=boot, revision=revision, sample_time=now)
    if not enabled or status in {"online", "unknown"}:
        state.pop("outage_start", None)
        state.pop("reconnect_time", None)
        return None
    elapsed = now - state.setdefault("outage_start", now)
    if state.get("reboot_queued"):
        return None
    if elapsed >= REBOOT_AFTER:
        return "reboot"
    last_reconnect = state.get("reconnect_time")
    if (
        status != "no_carrier"
        and elapsed >= RECONNECT_AFTER
        and (last_reconnect is None or now - last_reconnect >= RECONNECT_INTERVAL)
    ):
        return "reconnect"
    return None


def set_action(state: dict, action: str, result: str, reason: str) -> None:
    state[f"last_{action}"] = {"result": result, "at": state["checked_at"], "reason": reason}
    print(f"{state['interface']} {action} {result} ({reason})", flush=True)


def save(path: Path, state: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def main(settings: Path, interface: str, path: Path) -> None:
    data = read_object(settings)
    config = data.get(SETTINGS_SECTION, {})
    # 配置文件读不到时只观测，避免在配置损坏时执行破坏性操作。
    enabled = bool(data) and isinstance(config, dict) and config.get("enabled", True) is True
    config = config if isinstance(config, dict) else {}
    try:
        authorized = AUTHORIZATION.read_text().strip() == f"{pwd.getpwuid(os.getuid()).pw_name} {interface}"
    except OSError:
        authorized = False
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    now = time.monotonic()
    state = read_object(path)
    sample = inspect_link(interface)
    if state.get("status") != sample["status"] or state.get("connectivity") != sample["connectivity"]:
        print(f"{interface} {sample['status']} connectivity={sample['connectivity']}", flush=True)
    state.update(sample, interface=interface, authorized=authorized, checked_at=datetime.now(timezone.utc).isoformat())
    action = decide(state, sample["status"], now, boot, enabled and authorized, config.get("revision", ""))
    state["outage_seconds"] = round(now - state["outage_start"]) if "outage_start" in state else 0

    if action == "reconnect":
        state["reconnect_time"] = now
    if action == "reboot":
        # 先落盘，以便关机时仍能保留原因。
        set_action(state, action, "requested", sample["status"])
        save(path, state)
    if action:
        command = RECONNECT if action == "reconnect" else REBOOT
        try:
            result = run("/usr/bin/sudo", "-n", *command, timeout=65)
            success = result.returncode == 0
            if not success:
                print(result.stderr.strip(), flush=True)
        except (OSError, subprocess.TimeoutExpired) as error:
            print(error, flush=True)
            success = False
        if action == "reboot":
            state["reboot_queued"] = success
        elif success:
            recovered = inspect_link(interface)
            state.update(recovered)
            if recovered["status"] == "online":
                state.pop("outage_start", None)
                state.pop("reconnect_time", None)
                state["outage_seconds"] = 0
        result_name = "failed" if not success else "success"
        if action == "reconnect" and success and state["status"] != "online":
            result_name = "still_offline"
        set_action(state, action, result_name, sample["status"])
    save(path, state)


if __name__ == "__main__":
    settings_file, monitored_interface = sys.argv[1:]
    main(Path(settings_file), monitored_interface, state_path())
