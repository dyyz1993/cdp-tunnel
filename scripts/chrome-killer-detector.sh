#!/bin/bash
#
# Chrome 进程杀手检测器
# 持续监控 Chrome 主进程，一旦被杀立刻记录：
#   - 被杀时间
#   - 谁杀的 (PPID/进程名)
#   - 退出信号 (SIGTERM/SIGKILL/崩溃)
#
# 用法:
#   bash scripts/chrome-killer-detector.sh
#
# 日志输出到:
#   ~/.cdp-tunnel/chrome-kill-audit.log
#

LOG_FILE="$HOME/.cdp-tunnel/chrome-kill-audit.log"
mkdir -p "$(dirname "$LOG_FILE")"

echo "" >> "$LOG_FILE"
echo "================================================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Chrome Killer Detector started" >> "$LOG_FILE"
echo "================================================================" >> "$LOG_FILE"

log_audit() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# 上一次看到的 Chrome PID
LAST_PID=""

while true; do
    # 找 Chrome 主进程 (不是 Helper/Renderer)
    CHROME_PID=$(pgrep -x "Google Chrome" 2>/dev/null | head -1)
    
    if [ -z "$CHROME_PID" ]; then
        # Chrome 不存在了
        if [ -n "$LAST_PID" ]; then
            # 刚刚还在，现在没了！抓凶手
            log_audit "!!! CHROME KILLED !!! Previous PID=$LAST_PID is GONE"
            log_audit "  Exit time: $(date '+%Y-%m-%d %H:%M:%S')"
            
            # 检查是否有 crash report
            LATEST_CRASH=$(ls -t ~/Library/Logs/DiagnosticReports/ 2>/dev/null | grep -i "chrome\|google" | head -1)
            if [ -n "$LATEST_CRASH" ]; then
                log_audit "  Chrome crash report found: $LATEST_CRASH"
            else
                log_audit "  NO Chrome crash report -> killed by external process (NOT crash)"
            fi
            
            # 检查最近的 node crash (可能是 node::Kill 连带)
            RECENT_NODE_CRASHES=$(ls -t ~/Library/Logs/DiagnosticReports/node-*.ips 2>/dev/null | head -3)
            if [ -n "$RECENT_NODE_CRASHES" ]; then
                log_audit "  Recent node crashes (possible culprit):"
                echo "$RECENT_NODE_CRASHES" | while read -r f; do
                    log_audit "    $(basename "$f")"
                done
            fi
            
            # 检查系统 kill 记录
            KILL_LOG=$(log show --predicate 'eventMessage contains "kill" AND (eventMessage contains "Chrome" OR eventMessage contains "chrome")' --last 30s --style compact 2>/dev/null | tail -5)
            if [ -n "$KILL_LOG" ]; then
                log_audit "  System kill log:"
                echo "$KILL_LOG" | while read -r line; do
                    log_audit "    $line"
                done
            fi
            
            # 检查谁在跑 kill 相关命令
            KILLERS=$(ps aux | grep -E "kill|pkill|killall" | grep -v grep | grep -v "chrome-killer")
            if [ -n "$KILLERS" ]; then
                log_audit "  Active kill commands:"
                echo "$KILLERS" | while read -r line; do
                    log_audit "    $line"
                done
            fi
            
            # 当前连着 9221 的进程 (CDP 客户端嫌疑人)
            CDP_CLIENTS=$(lsof -i :9221 2>/dev/null | grep ESTABLISHED | grep -v "Google")
            if [ -n "$CDP_CLIENTS" ]; then
                log_audit "  CDP clients connected at time of death:"
                echo "$CDP_CLIENTS" | while read -r line; do
                    log_audit "    $line"
                done
            fi
            
            # 当前所有 node 进程 (可能凶手)
            NODE_PROCS=$(ps aux | grep "node " | grep -v grep | grep -v "chrome-killer" | head -10)
            if [ -n "$NODE_PROCS" ]; then
                log_audit "  Running node processes (suspects):"
                echo "$NODE_PROCS" | while read -r line; do
                    log_audit "    $line"
                done
            fi
            
            log_audit "!!! END OF INCIDENT !!!"
            echo "" >> "$LOG_FILE"
            
            LAST_PID=""
        fi
    else
        # Chrome 还在
        if [ "$CHROME_PID" != "$LAST_PID" ]; then
            # 新的 Chrome 进程 (可能重启了)
            log_audit "Chrome detected: PID=$CHROME_PID"
            LAST_PID="$CHROME_PID"
        fi
    fi
    
    sleep 2
done
