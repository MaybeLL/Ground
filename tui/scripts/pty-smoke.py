"""macOS/Linux PTY smoke: pass the TUI command and its arguments after this script."""
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = os.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()

def read_until(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            output.extend(os.read(master, 65536))
        if predicate():
            return
        if process.poll() is not None:
            raise AssertionError("TUI exited before expected frame: " + output.decode(errors="replace"))
    raise AssertionError("Timed out waiting for terminal state: " + output.decode(errors="replace")[-4000:])

def press(value):
    os.write(master, value)
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.03)[0]:
            output.extend(os.read(master, 65536))

try:
    read_until(lambda: "Grounds · 只读 · Requirement".encode() in output)
    candidate = os.environ.get('GROUNDS_TUI_SMOKE_CANDIDATE')
    if candidate:
        press(b'g')
        press(candidate.encode())
        press(b'\r')
        # Git Candidates open on their archive/history overview. Select the
        # submission child before checking its rendered Markdown body.
        read_until(lambda: '结构目录'.encode() in output and '提交说明'.encode() in output and '本机代码可用性'.encode() in output)
        press(b'\x1b[C')
        read_until(lambda: 'Fixture one'.encode() in output)
        assert '# Fixture one'.encode() not in output, 'Heading was not rendered'
        # Inspect terminal transitions: moving selection must not erase the viewport.
        for key in (b'\x1b[B', b'\x1b[A'):
            output.clear()
            press(key)
            assert output, 'Direction key produced no terminal update'
            erased = output.count(b'\x1b[2K')
            assert erased < 10 and b'\x1b[2J' not in output, f'Direction key erased {erased} lines (full-frame redraw)'
        print('PTY PASS: direction keys update without full-frame erasure')
        output.clear()
        press(b'\t')
        read_until(lambda: 'Tab/Esc/← 返回目录'.encode() in output)
        press(b'\x1b[F')
        press(b'\x1b[H')
        output.clear()
        press(b'\x1b')
        read_until(lambda: '←/→ 层级'.encode() in output)
        print('PTY PASS: Candidate structured preview, immediate body, and directory return')
    requirement = os.environ.get('GROUNDS_TUI_SMOKE_REQUIREMENT')
    if requirement:
        # Optional read-only check against a selected Markdown Requirement.
        # Wait between input events so Ink does not receive combined keystrokes.
        output.clear()
        press(b'/')
        read_until(lambda: '筛选已加载资源:'.encode() in output)
        press(requirement.encode())
        press(b'\r')
        output.clear()
        press(b'\r')
        read_until(lambda: '结构目录'.encode() in output and 'Requirement'.encode() in output)
        read_until(lambda: '背景'.encode() in output)
        press(b'\t')
        for _ in range(80):
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
            if '┬'.encode() in output:
                break
            press(b'\x1b[6~')
        assert '┬'.encode() in output, 'No rendered Markdown table in detail pane: ' + output.decode(errors='replace')[-4000:]
        print('PTY PASS: selected Requirement Markdown table renders while scrolling')
        press(b'\t')  # Return focus to directory for the shared resize check.
    # Resize exercises the narrow-screen path, not just initial width detection.
    output.clear()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 65, 0, 0))
    os.kill(process.pid, signal.SIGWINCH)
    os.write(master, b"\t")
    read_until(lambda: "Tab/Esc/← 返回目录".encode() in output)
    os.write(master, b"\x03")
    read_until(lambda: b"\x1b[?1049l" in output)
    assert process.wait(timeout=10) == 0
    assert termios.tcgetattr(slave) == original, "Terminal attributes were not restored"
    print("PTY PASS: startup, resize, narrow detail, Ctrl+C, alternate-screen and terminal-attribute restoration")
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
