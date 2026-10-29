"""Recover a stale suite publication through the real TUI and CLI."""
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import fcntl


master, slave = os.openpty()
original = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = bytearray()


def collect(seconds=.25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], .03)[0]:
            output.extend(os.read(master, 65536))


def settle(floor=.05, quiet=.12, cap=1.0):
    """Drain until the terminal has been silent for `quiet`, never before `floor`.

    The floor keeps a key from arriving before Ink registers its input handlers;
    the quiet window replaces the fixed sleeps that used to burn their full
    duration on every press.
    """
    start = last = time.monotonic()
    while True:
        now = time.monotonic()
        if now - start >= cap:
            return
        if select.select([master], [], [], .02)[0]:
            output.extend(os.read(master, 65536))
            last = time.monotonic()
            continue
        if now - start >= floor and now - last >= quiet:
            return

def wait(value, timeout=30):
    deadline = time.monotonic() + timeout
    while value.encode() not in output and time.monotonic() < deadline:
        collect(.1)
        if process.poll() is not None:
            break
    assert value.encode() in output, 'Missing ' + value + '\n' + output.decode(errors='replace')[-4000:]
    # 标题可能先于加载结束出现；等终端静默，避免 Enter 被 busy guard 丢弃。
    settle()


def press(keys):
    output.clear()
    os.write(master, keys.encode())
    settle()


def select_text(value, previous=''):
    press('/')
    for _ in previous:
        press('\x7f')
    press(value)
    wait('筛选：' + value)
    press('\r')
    press('\r')


try:
    wait('评测工作台')
    press('\r')
    wait('题集与评分')
    press('\x1b[B')
    press('\r')
    wait('题集 · v8')
    press('\r')
    wait('题集编排')
    select_text('按原请求恢复')
    wait('发布确认')
    press('\r')
    wait('resource version is no longer current')
    press(':')
    wait('查看完整错误')
    press('\x1b')
    press('\x1b')
    wait('题集编排')
    select_text('读取最新版本', '按原请求恢复')
    wait('题集冲突')
    press('\r')
    wait('题集编排')
    select_text('检查变化')
    wait('发布确认')
    press('\r')
    wait('已发布题集')
    press('q')
    wait('\x1b[?1049l')
    assert process.wait(timeout=10) == 0
    assert termios.tcgetattr(slave) == original
    print('EVAL RECOVERY PTY PASS: stale version rejected, explicit recheck and single publish')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
