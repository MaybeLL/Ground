"""Exercise Eval UI and editor terminal ownership using the temporary CLI fixture."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
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

def wait(text, timeout=30):
    deadline = time.monotonic() + timeout
    while text.encode() not in output and time.monotonic() < deadline:
        collect(.1)
        if process.poll() is not None:
            break
    assert text.encode() in output, 'Missing ' + text + '\n' + output.decode(errors='replace')[-5000:]
    settle()

def press(keys):
    os.write(master, keys.encode())
    settle()

try:
    wait('评测工作台')
    press('\x1b[B')
    wait('读取于')
    for i in range(4):
        press(' ')
        if i < 3:
            press('\x1b[B')
    output.clear()
    press('c')
    wait('多组实验对照')
    wait('1–4/4')
    for rows, columns in [(24, 80), (10, 40), (40, 160)]:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        settle()
        assert process.poll() is None, 'Resize crashed'
    press('\x1b')
    output.clear()
    press('/')
    press('本机草稿')
    wait('筛选：本机草稿')
    press('\r')
    press('\r')
    wait('本机草稿')
    press('/')
    press('editing')
    press('\r')
    press('\r')
    wait('资产草稿')
    for rows, columns in [(10, 40), (24, 80)]:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        settle()
        output.clear()
        press('\r')
        press('VISIBLE_VALUE')
        wait('VISIBLE_VALUE')
        press('\x1b')
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
    os.kill(process.pid, signal.SIGWINCH)
    settle()
    press('\x1b[B')
    output.clear()
    press('\r')
    wait('EDITOR_HANDOFF_OK')
    wait('PTY 修改题面')
    output.clear()
    press('q')
    wait('\x1b[?1049l')
    assert process.wait(timeout=10) == 0
    assert termios.tcgetattr(slave) == original, 'Terminal attributes not restored'
    print('EVAL PTY PASS: four groups, 160/80/40 columns, external editor handoff and terminal restoration')
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    os.close(slave)
