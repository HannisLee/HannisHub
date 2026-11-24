#!/usr/bin/env bash
# 先安装用户级巡检，再由管理员完成系统权限切换。
set -euo pipefail

if [[ ${1:-} == --authorize ]]; then
    [[ $EUID == 0 && $# == 3 && ${SUDO_USER:-} =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 2
    account=$SUDO_USER
    interface=$2
    profile=$3
    [[ $interface =~ ^[a-zA-Z0-9_.-]{1,15}$ && $profile =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || exit 2
    /usr/bin/ip link show dev "$interface" >/dev/null
    /usr/bin/nmcli -g connection.uuid connection show uuid "$profile" >/dev/null
    temporary=$(mktemp -d)
    trap 'find "$temporary" -maxdepth 1 -type f -delete; rmdir "$temporary"' EXIT
    cat > "$temporary/hannishub-network-reconnect.service" <<UNIT
[Unit]
Description=重新激活 HannisHub 主网卡连接
After=NetworkManager.service
Requires=NetworkManager.service

[Service]
Type=oneshot
ExecStart=-/usr/bin/nmcli --wait 8 connection down uuid $profile
ExecStart=/usr/bin/nmcli --wait 45 connection up uuid $profile ifname $interface
TimeoutStartSec=60s
UNIT
    cat > "$temporary/hannishub-network" <<RULE
$account ALL=(root) NOPASSWD: /usr/bin/systemctl --system start hannishub-network-reconnect.service, /usr/bin/systemctl --system --no-block reboot
RULE
    /usr/sbin/visudo -cf "$temporary/hannishub-network"
    /usr/bin/systemd-analyze verify "$temporary/hannishub-network-reconnect.service"
    install -o root -g root -m 0644 "$temporary/hannishub-network-reconnect.service" /etc/systemd/system/
    systemctl daemon-reload
    install -d -o root -g root -m 0755 /etc/hannishub-network
    install -o root -g root -m 0440 "$temporary/hannishub-network" /etc/sudoers.d/
    if systemctl cat scheduled-reboot.timer >/dev/null 2>&1; then
        systemctl disable --now scheduled-reboot.timer
    fi
    printf '%s %s\n' "$account" "$interface" > "$temporary/authorized"
    install -o root -g root -m 0644 "$temporary/authorized" /etc/hannishub-network/
    exit
fi

if [[ $EUID == 0 || $# != 1 ]]; then
    printf '用法：bash %s <网卡>（以运行 Hub 的用户执行）\n' "$0" >&2
    exit 2
fi
interface=$1
[[ $interface =~ ^[a-zA-Z0-9_.-]{1,15}$ ]] || exit 2
root_dir=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
profile=$(/usr/bin/nmcli -g GENERAL.CON-UUID device show "$interface")
[[ $profile =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || {
    printf '请先激活 %s 的 NetworkManager 连接。\n' "$interface" >&2
    exit 2
}

user_units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d "$user_units" "$HOME/.config"
install -d -m 0700 "$HOME/.local/state/hannishub-network"
install -m 0644 "$root_dir/scripts/systemd"/hannishub-network.{service,timer} "$user_units/"
# systemd 环境文件使用双引号，转义路径中的引号和反斜线。
escaped_dir=${root_dir//\\/\\\\}
escaped_dir=${escaped_dir//\"/\\\"}
cat > "$HOME/.config/hannishub-network.env" <<ENV
HANNISHUB_NETWORK_WORKER="$escaped_dir/core/network_recovery.py"
HANNISHUB_NETWORK_SETTINGS="$escaped_dir/settings.json"
HANNISHUB_NETWORK_INTERFACE=$interface
ENV
systemctl --user daemon-reload
systemctl --user enable --now hannishub-network.timer
systemctl --user start hannishub-network.service
printf '巡检已启动。为启用恢复动作并停用旧任务，请执行：\n'
printf 'sudo bash %q --authorize %q %q\n' "$root_dir/scripts/install_network_recovery.sh" "$interface" "$profile"
